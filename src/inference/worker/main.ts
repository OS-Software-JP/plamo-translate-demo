// Worker の本体。@litert-lm/core を呼ぶ唯一の場所。専用 Worker (dedicated.ts) と SharedWorker (shared.ts) の両方から使う。
import {
  Backend,
  Engine,
  SamplerType,
  getGlobalLiteRtLm,
  loadLiteRtLm,
  setupDefaultWebGpuDevice,
  type Conversation,
  type Message,
} from '@litert-lm/core';
import type {ContextLength} from '../../config/models';
import {isToneToken, toneRowsOf} from '../../config/tones';
import type {
  LoadRequest,
  LoadResult,
  TranslationRequest,
  TranslationResult,
  WorkerEvent,
  WorkerHandlers,
  WorkerMethod,
  WorkerRequest,
  WorkerResponse,
} from '../protocol';
import {checkEnvironment} from './environment';
import {deleteCachedModel, ensureModelFile, listCachedModels} from './modelStore';
import {splitParagraphs} from './paragraphs';
import {MAX_EMPTY_CHUNKS, NO_CHUNK_TIMEOUT_MS, runawayRepeatEnd, trimForeignTail} from './repetition';
import {countPromptTokens, createTokenizer, type Tokenizer} from './tokenizer';
import {withToneRows} from './tones';
import {WorkerError, errorMessage, toFailure} from './workerError';

/** エラー文の例: Input token ids are too long. Exceeding the maximum number of tokens allowed: 6328 >= 2048 */
const INPUT_TOO_LONG = /too long.*?(\d+)\s*>=\s*(\d+)/;

let engine: Engine | null = null;
let gpuDevice: GPUDevice | null = null;
let contextLength: ContextLength = 2048;
let loading = false;
let downloadController: AbortController | null = null;
let conversation: Conversation | null = null;
let stopRequested = false;
/** プロンプトのトークン数を数えるトークナイザー。読み込みに失敗したら null (数えずに翻訳する)。 */
let tokenizerReady: Promise<Tokenizer | null> = Promise.resolve(null);
/** 読み込んだモデルに口調の行を差し込んだか。 */
let tonesApplied = false;

async function loadTokenizer(url: string): Promise<Tokenizer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return createTokenizer(await response.text());
  } catch (error) {
    console.warn(`[plamo-translate-demo] tokenizer is not available: ${errorMessage(error)}`);
    return null;
  }
}

let eventSink: (event: WorkerEvent) => void = () => {};
const emit = (event: WorkerEvent): void => eventSink(event);

/** イベント (進捗、訳文、GPU のエラー) の送り先を決める。 */
export function setEventSink(sink: (event: WorkerEvent) => void): void {
  eventSink = sink;
}

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).flatMap(part => (part.type === 'text' ? [part.text] : [])).join('');
}

/** GPU のエラーは LiteRT-LM に伝わらず、バッファの作成に失敗しても Engine.create は成功する。 */
function watchDevice(device: GPUDevice): void {
  device.addEventListener('uncapturederror', event => {
    const {error} = event as GPUUncapturedErrorEvent;
    emit({event: 'gpuError', message: error.message, outOfMemory: error instanceof GPUOutOfMemoryError});
  });
  void device.lost.then(info => {
    emit({event: 'gpuLost', reason: info.reason, message: info.message});
  });
}

async function load(request: LoadRequest): Promise<LoadResult> {
  // Engine は 1 つの Worker で一度だけ作る。切り替えるときは Worker ごと作り直す。
  if (engine || loading) throw new WorkerError('unknown', 'model is already loaded in this worker');
  loading = true;

  const {model, modelUrl, wasmBaseUrl, cacheFileName} = request;
  // 語彙はモデルと並行して読む (約 3.5 MB)。
  tokenizerReady = loadTokenizer(request.tokenizerUrl);
  downloadController = new AbortController();
  const {file, downloaded} = await ensureModelFile(
    modelUrl,
    cacheFileName,
    model.sizeBytes,
    downloadController.signal,
    loadedBytes => emit({event: 'downloadProgress', loadedBytes, totalBytes: model.sizeBytes}),
  );
  downloadController = null;
  emit({event: 'initializing'});
  // 口調の行を差し込む。ファイルが想定と違えば差し込まず、口調だけを使えなくする。
  const toneRows = toneRowsOf(model.id);
  const patched = toneRows ? await withToneRows(file, toneRows) : null;
  if (toneRows && !patched) console.warn('[plamo-translate-demo] tone rows were not applied: the model file differs from the expected one');
  tonesApplied = patched !== null;

  const startedAt = performance.now();
  // Worker では .wasm の場所を自動で判定できない。ランタイムのログは原文を含むおそれがあるので出さない。
  (self as unknown as {Module: unknown}).Module = {
    locateFile: (name: string) => wasmBaseUrl + name,
    print: () => {},
    printErr: () => {},
  };
  await loadLiteRtLm(wasmBaseUrl);
  await setupDefaultWebGpuDevice();
  const device = getGlobalLiteRtLm().liteRtLmWasm.preinitializedWebGPUDevice;
  if (!device) throw new WorkerError('unknown', 'WebGPU device is not available');
  gpuDevice = device;
  watchDevice(device);
  // 照合ツール (scripts/verify) が実際の GPU エラーを起こすための入口。本番ビルドには含まれない。
  if (import.meta.env.DEV || import.meta.env.MODE === 'verify') {
    (self as unknown as {plamoDevice: GPUDevice}).plamoDevice = device;
  }

  contextLength = request.contextLength;
  engine = await Engine.create({
    model: patched ?? file,
    backend: Backend.GPU,
    benchmarkEnabled: true,
    // 省略すると SDK が 4096 トークンまでに制限する。
    mainExecutorSettings: {maxNumTokens: contextLength},
  });
  // 初めて読み込むときは、完了時点で GPU に数秒分の処理が残っている。
  await device.queue.onSubmittedWorkDone();
  return {loadSeconds: (performance.now() - startedAt) / 1000, downloaded};
}

function toTranslationError(error: unknown): WorkerError {
  const message = errorMessage(error);
  const tooLong = INPUT_TOO_LONG.exec(message);
  if (tooLong) {
    return new WorkerError('input-too-long', message, {
      inputTokens: Number(tooLong[1]),
      tokenLimit: Number(tooLong[2]),
    });
  }
  return new WorkerError('unknown', message);
}

type ExtraContext = Record<string, string | Array<{source: string; target: string}>>;

/** 1 つの会話 (段落ごとに分けたときは 1 つの段落) の生成の結果と計測値。 */
interface SegmentResult {
  stopped: boolean;
  output: string;
  /** 口調付きの翻訳で、止まらない繰り返しを見つけて生成を打ち切ったか。 */
  repeatCut: boolean;
  /** SDK の値 (完了したときだけ)。 */
  tokens: number;
  prefillTokens: number;
  prefillTokensPerSecond: number;
  decodeTokens: number;
  decodeTokensPerSecond: number;
  /** 会話を作ってから最初の出力まで (出力がなければ終わりまで) の秒数。 */
  prefillSeconds: number;
  /** 最初の出力から最後の出力までの秒数。 */
  decodeSeconds: number;
  /** 受け取ったチャンクの数と、最後の出力までに受け取ったチャンクの数。 */
  chunks: number;
  outputChunks: number;
}

/** 生成中の計測値の、前の段落までの合計。 */
interface Totals {
  prefillSeconds: number;
  decodeSeconds: number;
  chunks: number;
}

/**
 * 1 つの会話で原文を訳す。shownBefore は前の段落までの訳文 (区切りを含む) で、
 * 繰り返しを打ち切ったときに表示中の訳文を置き換えるのに使う。
 */
async function generate(
  text: string,
  extraContext: ExtraContext,
  tone: boolean,
  shownBefore: string,
  totals: Totals,
): Promise<SegmentResult> {
  if (!engine) throw new WorkerError('unknown', 'model is not loaded');
  const current = await engine.createConversation({
    preface: {extra_context: extraContext},
    sessionConfig: {
      // コンテキスト長より先に止まると、切れたことを検出できない。
      maxOutputTokens: contextLength,
      // 同じ入力で同じ結果にする。WebGPU のサンプラーは type ではなく k を見るので k: 1 が必須。
      samplerParams: {type: SamplerType.GREEDY, k: 1, p: 1, temperature: 1, seed: 1},
    },
  });
  conversation = current;

  const startedAt = performance.now();
  let output = '';
  let firstOutputAt: number | null = null;
  let lastOutputAt: number | null = null;
  // 最後の出力までに受け取ったチャンクの数。完了後の速度を、生成中と同じ式で求めるのに使う。
  let lastOutputChunks = 0;
  let chunks = 0;
  let repeatCut = false;
  // 文字を返さない生成 (空のチャンク) が続いた回数。
  let emptyChunks = 0;

  const result = async (stopped: boolean): Promise<SegmentResult> => {
    const measured = {
      prefillSeconds: ((firstOutputAt ?? performance.now()) - startedAt) / 1000,
      // 生成中に表示した秒数 (最後の出力の時点) と同じ値にして、完了時に変わらないようにする。
      decodeSeconds: firstOutputAt === null || lastOutputAt === null ? 0 : (lastOutputAt - firstOutputAt) / 1000,
      chunks,
      outputChunks: lastOutputChunks,
    };
    if (stopped) {
      const none = {tokens: 0, prefillTokens: 0, prefillTokensPerSecond: 0, decodeTokens: 0, decodeTokensPerSecond: 0};
      return {stopped, output, repeatCut, ...none, ...measured};
    }
    // 口調付きの訳 (日本語) の末尾に残った文字化けの断片を除く。
    const final = tone ? trimForeignTail(output) : output;
    // 打ち切った分や除いた分が表示に残らないよう、表示中の訳文を置き換える (完了の訳文でも置き換わる)。
    if (tone && (repeatCut || final !== output)) {
      emit({event: 'output', text: shownBefore + final, replace: true, progress: progressAt(lastOutputAt ?? performance.now())});
    }
    const benchmark = await current.getBenchmarkInfo();
    return {
      stopped,
      output: final,
      repeatCut,
      tokens: await current.getTokenCount(),
      prefillTokens: benchmark.lastPrefillTokenCount,
      prefillTokensPerSecond: benchmark.lastPrefillTokensPerSecond,
      decodeTokens: benchmark.lastDecodeTokenCount,
      decodeTokensPerSecond: benchmark.lastDecodeTokensPerSecond,
      ...measured,
    };
  };

  // 生成中の計測値。前の段落までの合計に、この段落の分を足す。
  const progressAt = (now: number) => ({
    prefillSeconds: totals.prefillSeconds + ((firstOutputAt ?? now) - startedAt) / 1000,
    decodeTokens: totals.chunks + chunks,
    decodeSeconds: totals.decodeSeconds + (firstOutputAt === null ? 0 : (now - firstOutputAt) / 1000),
  });

  // 口調付きの翻訳で、最初の出力の後にチャンクが届かなくなったら、止まらない繰り返しとみなして打ち切る
  // (文字にならないバイトのトークンを出し続けると、SDK は上限まで生成してから文字化けをまとめて返すため)。
  let lastChunkAt = performance.now();
  const watchdog = tone
    ? setInterval(() => {
        if (firstOutputAt !== null && !repeatCut && !stopRequested && performance.now() - lastChunkAt > NO_CHUNK_TIMEOUT_MS) {
          repeatCut = true;
          current.cancel();
        }
      }, 500)
    : null;

  try {
    if (!stopRequested) {
      for await (const chunk of current.sendMessageStreaming(text)) {
        // 打ち切った後に届いた分 (文字化け) は使わない。
        if (repeatCut) break;
        lastChunkAt = performance.now();
        // 生成中の計測値に使う。空のチャンクも 1 回の生成にあたるので数える。
        chunks++;
        const piece = textOf(chunk);
        if (!piece) {
          // 正しい文字にならないバイトのトークンを出し続けている。文字にならない分は捨てて打ち切る。
          if (tone && ++emptyChunks >= MAX_EMPTY_CHUNKS) {
            repeatCut = true;
            current.cancel();
            break;
          }
          continue;
        }
        emptyChunks = 0;
        const now = performance.now();
        firstOutputAt ??= now;
        lastOutputAt = now;
        lastOutputChunks = chunks;
        output += piece;
        emit({event: 'output', text: piece, progress: progressAt(now)});
        // 繰り返しは最初の 1 回だけを残して打ち切る。
        const keep = tone ? runawayRepeatEnd(output) : null;
        if (keep !== null) {
          output = output.slice(0, keep);
          repeatCut = true;
          current.cancel();
          break;
        }
      }
    }
    return await result(stopRequested);
  } catch (error) {
    // 停止すると SDK は Task cancelled を投げるが、利用者にとってはエラーではない。
    if (stopRequested) return await result(true);
    // 繰り返しで打ち切ったときも Task cancelled が届くことがある。
    if (repeatCut) return await result(false);
    throw toTranslationError(error);
  } finally {
    if (watchdog !== null) clearInterval(watchdog);
    conversation = null;
    // 原文の処理中に停止したときは、ここで処理の完了を待つ (GPU が空くまで戻らない)。
    await current.delete();
    // GPU のエラーは GPU の処理が動くまで届かない。壊れた訳文を正常に見せないよう、届けてから結果を返す。
    await gpuDevice?.queue.onSubmittedWorkDone();
  }
}

/** 段落の和の速度。各段落の「トークン数 ÷ 速度」(秒数) を足して、合計のトークン数を割る。 */
function combinedSpeed(
  segments: SegmentResult[],
  tokensOf: (s: SegmentResult) => number,
  speedOf: (s: SegmentResult) => number,
): number {
  const tokens = segments.reduce((sum, s) => sum + tokensOf(s), 0);
  const seconds = segments.reduce((sum, s) => sum + (speedOf(s) > 0 ? tokensOf(s) / speedOf(s) : 0), 0);
  return seconds > 0 ? tokens / seconds : 0;
}

async function translate(request: TranslationRequest): Promise<TranslationResult> {
  if (!engine) throw new WorkerError('unknown', 'model is not loaded');
  const tone = isToneToken(request.target);
  if (tone && !tonesApplied) throw new WorkerError('tone-unavailable', 'tone rows are not applied to this model');
  const extraContext: ExtraContext = {target_lang: request.target};
  if (request.source) extraContext.source_lang = request.source;
  if (request.form && request.target === 'ja') extraContext.form = request.form;
  if (request.context) extraContext.context = request.context;
  if (request.glossary?.length) extraContext.glossary = request.glossary.map(({source, target}) => ({source, target}));
  // 口調付きの翻訳は、空行で区切った段落を 1 つずつ別に訳す (6.9 節)。段落が 1 つなら原文のまま訳す。
  const paragraphs = tone ? splitParagraphs(request.text) : [];
  const parts = paragraphs.length > 1 ? paragraphs : [{text: request.text, separator: ''}];
  const split = parts.length > 1;

  stopRequested = false;
  // プロンプトのトークン数を先に数える。SDK は生成が終わるまでトークン数を返さないため。
  // 停止の受け付けを初期化した後に数えるので、数えている間に停止されても失われない。
  const tokenizer = await tokenizerReady;
  const promptTokens = tokenizer ? parts.map(part => countPromptTokens(tokenizer, {...request, text: part.text})) : null;
  if (promptTokens) {
    // SDK と同じ条件 (トークン数 >= コンテキスト長) で、GPU に送る前に断る。段落ごとに分けるときは、いちばん長い段落で見る。
    const largest = Math.max(...promptTokens);
    if (largest >= contextLength) {
      throw new WorkerError('input-too-long', `prompt tokens ${largest} >= ${contextLength}`, {
        inputTokens: largest,
        tokenLimit: contextLength,
      });
    }
  }

  const totals: Totals = {prefillSeconds: 0, decodeSeconds: 0, chunks: 0};
  const segments: SegmentResult[] = [];
  let output = '';
  for (const [index, part] of parts.entries()) {
    if (stopRequested) return {kind: 'stopped', output};
    if (promptTokens) {
      const started = promptTokens.slice(0, index + 1);
      emit({
        event: 'prompt',
        tokens: started.reduce((a, b) => a + b, 0),
        ...(split ? {decodeLimit: started.reduce((sum, tokens) => sum + contextLength - tokens, 0)} : {}),
      });
    }
    const segment = await generate(part.text, extraContext, tone, output, totals);
    output += segment.output;
    if (segment.stopped) return {kind: 'stopped', output};
    segments.push(segment);
    if (index < parts.length - 1) {
      totals.prefillSeconds += segment.prefillSeconds;
      totals.decodeSeconds += segment.decodeSeconds;
      totals.chunks += segment.chunks;
      output += part.separator;
      const progress = {prefillSeconds: totals.prefillSeconds, decodeTokens: totals.chunks, decodeSeconds: totals.decodeSeconds};
      emit({event: 'output', text: part.separator, progress});
    }
  }

  const last = segments[segments.length - 1];
  const sum = (of: (s: SegmentResult) => number) => segments.reduce((total, s) => total + of(s), 0);
  const prefillTokens = sum(s => s.prefillTokens);
  return {
    kind: 'done',
    // 完了の訳文で、表示中の訳文を置き換える。
    output,
    truncated: segments.some(s => !s.repeatCut && s.tokens >= contextLength),
    metrics: {
      firstOutputSeconds: sum(s => s.prefillSeconds),
      prefillTokens,
      prefillTokensPerSecond: combinedSpeed(segments, s => s.prefillTokens, s => s.prefillTokensPerSecond),
      decodeTokens: sum(s => s.decodeTokens),
      decodeTokensPerSecond: combinedSpeed(segments, s => s.decodeTokens, s => s.decodeTokensPerSecond),
      // 生成中に表示した値 (最後の出力の時点) と同じにする。
      decodeSeconds: totals.decodeSeconds + last.decodeSeconds,
      decodeChunks: totals.chunks + last.outputChunks,
      contextTokens: sum(s => s.tokens),
      contextLength,
      ...(split ? {decodeLimit: segments.length * contextLength - prefillTokens} : {}),
    },
  };
}

export const handlers: WorkerHandlers = {
  checkEnvironment,
  listCachedModels,
  deleteCachedModel,
  load,
  cancelDownload() {
    downloadController?.abort();
    return true;
  },
  translate,
  stop() {
    stopRequested = true;
    conversation?.cancel();
    return true;
  },
};

/** 1 件の呼び出しを処理する。失敗も応答として返す。 */
export async function handle({id, method, args}: WorkerRequest): Promise<WorkerResponse> {
  try {
    const handler = handlers[method as WorkerMethod] as (...values: unknown[]) => unknown;
    return {id, ok: true, result: await handler(...args)};
  } catch (error) {
    return {id, ok: false, failure: toFailure(error)};
  }
}
