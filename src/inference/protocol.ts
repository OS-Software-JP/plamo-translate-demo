// Worker と主スレッドの間のメッセージの型。
import type {ContextLength, ModelDefinition} from '../config/models';

export type UnsupportedReason = 'insecure-context' | 'webgpu-unavailable' | 'no-adapter' | 'software-adapter';

export type EnvironmentResult =
  | {supported: false; reason: UnsupportedReason}
  | {supported: true; bufferLimitBytes: number; gpuDescription: string};

export interface CachedModel {
  fileName: string;
  sizeBytes: number;
}

export interface LoadRequest {
  model: ModelDefinition;
  contextLength: ContextLength;
  modelUrl: string;
  wasmBaseUrl: string;
  cacheFileName: string;
  /** プロンプトのトークン数を数えるための語彙 (アプリに同梱)。読めなければ数えずに翻訳する。 */
  tokenizerUrl: string;
}

export interface LoadResult {
  /** 初期化にかかった秒数 (ダウンロードを含まない)。 */
  loadSeconds: number;
  downloaded: boolean;
}

export type JapaneseForm = 'polite' | 'plain';

export interface GlossaryEntry {
  source: string;
  target: string;
}

export interface TranslationRequest {
  text: string;
  /** 言語コードか、口調の予約トークン (config/tones.ts)。 */
  target: string;
  /** 省略すると自動判定。 */
  source?: string;
  /** 翻訳先が日本語のときだけ指定できる。 */
  form?: JapaneseForm;
  context?: string;
  glossary?: GlossaryEntry[];
}

export interface TranslationMetrics {
  /** 最初の出力までの実測の秒数。原文の欄に表示する。 */
  firstOutputSeconds: number;
  /** 原文の処理 (プレフィル) のトークン数と速度。 */
  prefillTokens: number;
  prefillTokensPerSecond: number;
  /** 訳文の生成 (デコード) のトークン数。SDK の値で、終わりの記号のトークンも含む。 */
  decodeTokens: number;
  /** SDK が測った生成の速度。画面には出さず、照合ツールで性能を測るのに使う。 */
  decodeTokensPerSecond: number;
  /** 最初の出力から最後の出力までの実測の秒数。生成中に表示した値と同じ測り方で、訳文の欄に表示する。 */
  decodeSeconds: number;
  /** 最後の出力までに受け取ったチャンクの数。訳文の欄の速度を、生成中と同じ式 (2 つ目以降の数 ÷ 秒数) で求めるのに使う。 */
  decodeChunks: number;
  /** 入力と出力の合計のトークン数。 */
  contextTokens: number;
  contextLength: ContextLength;
  /**
   * 段落ごとに分けて訳したとき (口調付きの翻訳、6.9 節) の、訳文に使える分の合計 (段落ごとの「コンテキスト長 − 原文の処理」の和)。
   * 分けなかったときは省き、画面ではコンテキスト長から原文の処理のトークン数を引いた残りを使う。
   * 段落ごとに分けたときは、ほかの値も段落の合計 (秒数は段落ごとの秒数の和) になる。
   */
  decodeLimit?: number;
}

export type TranslationResult =
  | {kind: 'done'; output: string; truncated: boolean; metrics: TranslationMetrics}
  | {kind: 'stopped'; output: string};

export type WorkerErrorCode =
  | 'input-too-long'
  | 'insufficient-storage'
  | 'download-failed'
  | 'download-cancelled'
  // 口調を選んだが、読み込んだモデルのファイルが想定と違い、口調の行を差し込めなかった。
  | 'tone-unavailable'
  | 'unknown';

export interface WorkerFailure {
  code: WorkerErrorCode;
  /** 開発者向けの詳細。原文と訳文を含めない。 */
  message: string;
  inputTokens?: number;
  tokenLimit?: number;
}

export interface WorkerApi {
  checkEnvironment(): EnvironmentResult;
  listCachedModels(validFileNames: string[]): CachedModel[];
  deleteCachedModel(fileName: string): boolean;
  load(request: LoadRequest): LoadResult;
  cancelDownload(): boolean;
  translate(request: TranslationRequest): TranslationResult;
  stop(): boolean;
}

export type WorkerMethod = keyof WorkerApi;

export type WorkerHandlers = {
  [M in WorkerMethod]: (
    ...args: Parameters<WorkerApi[M]>
  ) => ReturnType<WorkerApi[M]> | Promise<ReturnType<WorkerApi[M]>>;
};

export type WorkerRequest = {
  [M in WorkerMethod]: {id: number; method: M; args: Parameters<WorkerApi[M]>};
}[WorkerMethod];

export type WorkerResponse = {id: number; ok: true; result: unknown} | {id: number; ok: false; failure: WorkerFailure};

/**
 * 生成中の計測値。SDK は生成が終わるまで計測値を返さない (排他ロックで待たされる) ので、
 * Worker で受け取ったチャンクの数と時刻から求める。完了後は SDK の値に置き換える。
 * 段落ごとに分けて訳すときは、どれもそこまでの段落の合計 (秒数は段落ごとの秒数の和)。
 */
export interface DecodeProgress {
  /** 最初の出力までの秒数。原文の処理にかかった時間にあたる。 */
  prefillSeconds: number;
  /** これまでに受け取ったチャンクの数。生成したトークン数にあたる。 */
  decodeTokens: number;
  /** 最初の出力からの秒数。 */
  decodeSeconds: number;
}

export type WorkerEvent =
  | {event: 'downloadProgress'; loadedBytes: number; totalBytes: number}
  | {event: 'initializing'}
  // replace のときは、text がそれまでの訳文の全体 (繰り返しを打ち切った分を除いたもの) で、表示中の訳文を置き換える。
  | {event: 'output'; text: string; progress: DecodeProgress; replace?: boolean}
  // 翻訳を始めたときに数えたプロンプトのトークン数。SDK の原文の処理のトークン数と同じ値。
  // 段落ごとに分けて訳すときは、段落を始めるたびに、そこまでの段落の合計と、訳文に使える分の合計 (decodeLimit) を送る。
  | {event: 'prompt'; tokens: number; decodeLimit?: number}
  // 共有している Engine (6.7 節) で、ほかのタブの翻訳が終わるのを待ち始めた / 待ち終えて処理を始めた。
  | {event: 'queued'}
  | {event: 'started'}
  | {event: 'gpuError'; message: string; outOfMemory: boolean}
  | {event: 'gpuLost'; reason: string; message: string};

export type WorkerMessage = WorkerResponse | WorkerEvent;

/**
 * SharedWorker への接続の最初に送る。clientLock はタブが持ち続けるロックの名前で、
 * SharedWorker はその解放 (タブを閉じたか、接続を破棄した) で接続が終わったことを知る。
 */
export interface SharedHello {
  hello: {clientLock: string};
}

/**
 * SharedHello への返事。accepted なら aliveLock は SharedWorker が終了まで持ち続けるロックの名前で、
 * タブはその解放で SharedWorker が止まったことを知る。rejected は、GPU のエラーか読み込みの失敗で
 * 使えなくなり、終了を待っている SharedWorker の返事。
 */
export type SharedHelloReply = {hello: 'accepted'; aliveLock: string} | {hello: 'rejected'};
