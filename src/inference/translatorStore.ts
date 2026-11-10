// 推論の状態の管理。React の外に置き、再レンダーや StrictMode の二重実行で再初期化されないようにする。
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MODEL_ID,
  MODELS,
  cacheFileName,
  getModel,
  isContextLength,
  isModelId,
  modelUrl,
  tokenizerUrl,
  wasmBaseUrl,
  type ContextLength,
  type ModelId,
} from '../config/models';
import {isLanguageCode} from '../config/languages';
import {getTone, isToneId, toneRowsOf, type ToneId} from '../config/tones';
import {InferenceClient, WorkerCallError} from './client';
import {
  BUFFER_LIMIT_ERROR,
  GPU_ERRORS,
  RESERVED_TOKEN_ERROR,
  UNSUPPORTED_ERRORS,
  describeFailure,
  type UsedOptions,
  type UserFacingError,
} from './errors';
import type {
  DecodeProgress,
  GlossaryEntry,
  JapaneseForm,
  TranslationMetrics,
  TranslationRequest,
  WorkerEvent,
  WorkerFailure,
} from './protocol';

const RESERVED_TOKEN = '<|plamo:';
const OUTPUT_FLUSH_INTERVAL_MS = 50;
const SETTINGS_KEY = 'plamo-translate-demo:settings';
/** 保存済みのモデルの増減を、ほかのタブに知らせる。 */
const CACHE_CHANNEL = 'plamo-translate-demo:cache';

interface CacheChange {
  modelId: ModelId;
  cached: boolean;
}

export type ModelState =
  | {kind: 'checking'}
  | {kind: 'unsupported'; error: UserFacingError}
  | {kind: 'idle'}
  | {kind: 'downloading'; modelId: ModelId; loadedBytes: number; totalBytes: number}
  | {kind: 'initializing'; modelId: ModelId; contextLength: ContextLength}
  | {kind: 'ready'; modelId: ModelId; contextLength: ContextLength; loadSeconds: number}
  | {kind: 'failed'; error: UserFacingError};

export type TranslationState =
  | {kind: 'idle'}
  // 翻訳を始めたときにモデルが読み込まれていないので、読み込みが終わるのを待っている。
  | {kind: 'loading'; startedAt: number}
  // progress は最初の出力が届くまで null。queued は、共有している Engine でほかのタブの翻訳を待っている間 true。
  // promptTokens は、翻訳を始めたときに Worker が数えたプロンプトのトークン数 (数えられなければ undefined)。
  // 段落ごとに分けて訳すとき (6.9 節) は、promptTokens はそこまでの段落の合計で、decodeLimit は訳文に使える分の合計。
  | {
      kind: 'generating';
      output: string;
      startedAt: number;
      progress: DecodeProgress | null;
      queued?: boolean;
      promptTokens?: number;
      decodeLimit?: number;
    }
  | {kind: 'stopping'; output: string; startedAt: number}
  // used は依頼に含めた詳細オプション。切れたときの文面で、短くできるものを名指しする。
  | {kind: 'done'; output: string; truncated: boolean; metrics: TranslationMetrics; used?: UsedOptions}
  | {kind: 'stopped'; output: string}
  | {kind: 'failed'; output: string; error: UserFacingError};

/**
 * 文体の欄の値。やさしい日本語 (easy) は、PFML3 では文体ではなく翻訳先の言語 (ja-easy) として指定する。
 * 口調 (ToneId) は、翻訳先を口調の予約トークンにして指定する (config/tones.ts)。
 */
export type FormOption = JapaneseForm | 'easy' | ToneId;

const EASY_JAPANESE = 'ja-easy';

const isFormOption = (value: unknown): value is FormOption =>
  value === 'polite' || value === 'plain' || value === 'easy' || isToneId(value);

/** モデルで口調を選べるか (口調の行を学習したモデルか)。 */
export const tonesAvailable = (modelId: ModelId): boolean => toneRowsOf(modelId) !== undefined;

/**
 * 依頼する翻訳先と文体。翻訳先が日本語のときだけ文体の欄の値を使う。口調を選べないモデル (2B) では、
 * 選んでいた口調を使わずに訳す (画面の欄も「指定なし」と表示する)。
 */
function requestTarget(target: string, form: FormOption | '', modelId: ModelId): {target: string; form?: JapaneseForm} {
  if (target !== 'ja') return {target};
  if (form === 'polite' || form === 'plain') return {target, form};
  if (form === 'easy') return {target: EASY_JAPANESE};
  if (isToneId(form) && tonesAvailable(modelId)) return {target: getTone(form).token};
  return {target};
}

export interface TranslationOptions {
  /** 空文字は自動判定。 */
  source: string;
  target: string;
  form: FormOption | '';
}

/** 詳細オプション。翻訳のたびに送る参考文脈と用語集と、欄の開閉。 */
export interface AdvancedSettings {
  context: string;
  /** 入力途中の行 (原語か訳語が空) もそのまま残す。翻訳には両方ある行だけを使う。 */
  glossary: GlossaryEntry[];
  /** 詳細オプションの欄を開いているか。 */
  open: boolean;
}

export interface TranslatorState {
  model: ModelState;
  translation: TranslationState;
  selectedModelId: ModelId;
  selectedContextLength: ContextLength;
  options: TranslationOptions;
  advanced: AdvancedSettings;
  cachedModelIds: readonly ModelId[];
  /** 環境確認の後に分かる、使用中の GPU の名前。 */
  gpuDescription: string;
  /** バッファ上限が足りず、選べないモデル。 */
  unavailableModelIds: readonly ModelId[];
}

export type TranslationInput = Pick<TranslationRequest, 'text' | 'context' | 'glossary'>;

interface SavedSettings {
  modelId: ModelId;
  contextLength: ContextLength;
  options: TranslationOptions;
  advanced: AdvancedSettings;
}

/** 保存した設定をそのまま読む。読めなければ空にする。 */
function readSavedObject(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const isGlossaryEntry = (value: unknown): value is GlossaryEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as GlossaryEntry).source === 'string' &&
  typeof (value as GlossaryEntry).target === 'string';

function readSettings(): Partial<SavedSettings> {
  const saved = readSavedObject();
  const settings: Partial<SavedSettings> = {};
  if (isModelId(saved.modelId)) settings.modelId = saved.modelId;
  if (isContextLength(saved.contextLength)) settings.contextLength = saved.contextLength;
  const options = saved.options as Partial<TranslationOptions> | undefined;
  if (typeof options === 'object' && options !== null) {
    settings.options = {
      source: options.source === '' || isLanguageCode(options.source) ? (options.source ?? '') : '',
      target: isLanguageCode(options.target) ? options.target : 'ja',
      form: isFormOption(options.form) ? options.form : '',
    };
  }
  const advanced = saved.advanced as Partial<Record<keyof AdvancedSettings, unknown>> | undefined;
  if (typeof advanced === 'object' && advanced !== null) {
    settings.advanced = {
      context: typeof advanced.context === 'string' ? advanced.context : '',
      glossary: Array.isArray(advanced.glossary)
        ? advanced.glossary.filter(isGlossaryEntry).map(({source, target}) => ({source, target}))
        : [],
      open: advanced.open === true,
    };
  }
  return settings;
}

export function findReservedToken(input: TranslationInput): boolean {
  const values = [input.text, input.context ?? '', ...(input.glossary ?? []).flatMap(e => [e.source, e.target])];
  return values.some(value => value.includes(RESERVED_TOKEN));
}

/** 選択中のモデルとコンテキスト長が読み込まれていて、すぐに翻訳できるか。 */
function isSelectedReady({model, selectedModelId, selectedContextLength}: TranslatorState): boolean {
  return model.kind === 'ready' && model.modelId === selectedModelId && model.contextLength === selectedContextLength;
}

/**
 * 翻訳を始められるか (原文の有無は見ない)。選択中のモデルが読み込まれていなくても、
 * このブラウザに保存済みなら、読み込んでから翻訳する。未保存のモデルは、ダウンロードの操作を待つ。
 */
export function canStartTranslation(state: TranslatorState): boolean {
  const {model, translation, selectedModelId, cachedModelIds, unavailableModelIds} = state;
  if (translation.kind === 'loading' || translation.kind === 'generating' || translation.kind === 'stopping') return false;
  if (isSelectedReady(state)) return true;
  const loadable = model.kind === 'idle' || model.kind === 'ready' || model.kind === 'failed';
  return loadable && cachedModelIds.includes(selectedModelId) && !unavailableModelIds.includes(selectedModelId);
}

class TranslatorStore {
  private state: TranslatorState;
  private readonly listeners = new Set<() => void>();
  private initialized = false;
  private engine: InferenceClient | null = null;
  private pendingOutput = '';
  /** 表示中の訳文を置き換える訳文 (Worker が繰り返しを打ち切ったとき)。pendingOutput はその後に続く分。 */
  private pendingReplace: string | null = null;
  private pendingProgress: DecodeProgress | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cacheChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CACHE_CHANNEL) : null;

  constructor() {
    this.cacheChannel?.addEventListener('message', ({data}: MessageEvent<CacheChange>) => {
      if (isModelId(data?.modelId)) this.setCached(data.modelId, data.cached === true);
    });
    const saved = readSettings();
    this.state = {
      model: {kind: 'checking'},
      translation: {kind: 'idle'},
      selectedModelId: saved.modelId ?? DEFAULT_MODEL_ID,
      selectedContextLength: saved.contextLength ?? DEFAULT_CONTEXT_LENGTH,
      options: saved.options ?? {source: '', target: 'ja', form: ''},
      advanced: saved.advanced ?? {context: '', glossary: [], open: false},
      cachedModelIds: [],
      gpuDescription: '',
      unavailableModelIds: [],
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): TranslatorState => this.state;

  private update(patch: Partial<TranslatorState>): void {
    this.state = {...this.state, ...patch};
    for (const listener of this.listeners) listener();
  }

  /**
   * 変えた項目だけを保存した設定に書き足す。複数のタブで別の項目を変えても、互いに上書きしない
   * (このタブで変えていない参考文脈を、モデルの変更で古い値に戻さない)。
   */
  private saveSettings(patch: Partial<SavedSettings>): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({...readSavedObject(), ...patch}));
    } catch {
      // 保存できなくても動作に影響しない。
    }
  }

  /**
   * 環境を確認し、キャッシュの状態を調べる。何度呼んでも一度だけ実行する。
   * モデルは読み込まない。読み込むのは、利用者の操作か翻訳を始めたとき。
   */
  readonly initialize = async (): Promise<void> => {
    if (this.initialized) return;
    this.initialized = true;
    // HTTPS でも localhost でもないページでは、Worker への接続に使う crypto.randomUUID と Web Locks がなく、
    // 接続を始める前に例外になる。Worker に聞く前にここで断る。
    if (!isSecureContext) {
      this.update({model: {kind: 'unsupported', error: UNSUPPORTED_ERRORS['insecure-context']}});
      return;
    }
    let client: InferenceClient | null = null;
    try {
      client = new InferenceClient();
      const environment = await client.call('checkEnvironment');
      if (!environment.supported) {
        this.update({model: {kind: 'unsupported', error: UNSUPPORTED_ERRORS[environment.reason]}});
        return;
      }
      const unavailable = MODELS.filter(model => environment.bufferLimitBytes < model.largestBufferBytes);
      const unavailableModelIds = unavailable.map(model => model.id);
      if (unavailableModelIds.length === MODELS.length) {
        this.update({model: {kind: 'unsupported', error: BUFFER_LIMIT_ERROR}, unavailableModelIds});
        return;
      }
      const cachedModelIds = await this.fetchCachedModelIds(client);
      const selectedModelId = unavailableModelIds.includes(this.state.selectedModelId)
        ? (MODELS.find(model => !unavailableModelIds.includes(model.id))?.id ?? DEFAULT_MODEL_ID)
        : this.state.selectedModelId;
      this.update({
        model: {kind: 'idle'},
        cachedModelIds,
        unavailableModelIds,
        selectedModelId,
        gpuDescription: environment.gpuDescription,
      });
    } catch (error) {
      this.update({model: {kind: 'failed', error: this.toUserError(error)}});
    } finally {
      client?.terminate();
    }
  };

  private async fetchCachedModelIds(client: InferenceClient): Promise<ModelId[]> {
    const validNames = MODELS.map(cacheFileName);
    const cached = await client.call('listCachedModels', validNames);
    return MODELS.filter(model =>
      cached.some(entry => entry.fileName === cacheFileName(model) && entry.sizeBytes === model.sizeBytes),
    ).map(model => model.id);
  }

  private setCached(modelId: ModelId, cached: boolean): void {
    const {cachedModelIds} = this.state;
    if (cachedModelIds.includes(modelId) === cached) return;
    this.update({cachedModelIds: cached ? [...cachedModelIds, modelId] : cachedModelIds.filter(id => id !== modelId)});
  }

  /** このタブの保存済みの一覧を変え、ほかのタブにも知らせる。 */
  private changeCached(modelId: ModelId, cached: boolean): void {
    this.setCached(modelId, cached);
    this.cacheChannel?.postMessage({modelId, cached} satisfies CacheChange);
  }

  private isBusy(): boolean {
    const {model, translation} = this.state;
    return (
      model.kind === 'downloading' ||
      model.kind === 'initializing' ||
      translation.kind === 'generating' ||
      translation.kind === 'stopping'
    );
  }

  readonly selectModel = (modelId: ModelId): void => {
    this.update({selectedModelId: modelId});
    this.saveSettings({modelId});
  };

  readonly selectContextLength = (contextLength: ContextLength): void => {
    this.update({selectedContextLength: contextLength});
    this.saveSettings({contextLength});
  };

  readonly setOptions = (patch: Partial<TranslationOptions>): void => {
    const options = {...this.state.options, ...patch};
    this.update({options});
    this.saveSettings({options});
  };

  /** 参考文脈、用語集、詳細オプションの開閉を変えて保存する。 */
  readonly setAdvanced = (patch: Partial<AdvancedSettings>): void => {
    const advanced = {...this.state.advanced, ...patch};
    this.update({advanced});
    this.saveSettings({advanced});
  };

  /** 選択中のモデルを読み込む。キャッシュになければダウンロードする。 */
  readonly load = async (): Promise<void> => {
    if (this.isBusy()) return;
    const modelId = this.state.selectedModelId;
    const contextLength = this.state.selectedContextLength;
    if (this.state.unavailableModelIds.includes(modelId)) {
      this.update({model: {kind: 'failed', error: BUFFER_LIMIT_ERROR}});
      return;
    }
    const model = getModel(modelId);

    this.engine?.terminate();
    // 同じモデルとコンテキスト長を読み込んだタブは、1 つの Engine (GPU のメモリ) を共有する。
    const client = new InferenceClient(
      {
        onEvent: event => this.handleWorkerEvent(client, event),
        onCrash: () => this.failEngine(client, GPU_ERRORS.crashed),
      },
      `engine:${cacheFileName(model)}:${contextLength}`,
    );
    this.engine = client;

    // 主スレッドでしか使えない。拒否されても続行する。
    void navigator.storage?.persist?.().catch(() => {});

    const cached = this.state.cachedModelIds.includes(modelId);
    this.update({
      model: cached
        ? {kind: 'initializing', modelId, contextLength}
        : {kind: 'downloading', modelId, loadedBytes: 0, totalBytes: model.sizeBytes},
    });
    try {
      const result = await client.call('load', {
        model,
        contextLength,
        modelUrl: modelUrl(model),
        wasmBaseUrl: wasmBaseUrl(),
        cacheFileName: cacheFileName(model),
        tokenizerUrl: tokenizerUrl(),
      });
      if (this.engine !== client) return;
      this.update({model: {kind: 'ready', modelId, contextLength, loadSeconds: result.loadSeconds}});
      this.changeCached(modelId, true);
    } catch (error) {
      if (this.engine !== client) return;
      client.terminate();
      this.engine = null;
      if (error instanceof WorkerCallError && error.failure.code === 'download-cancelled') {
        this.update({model: {kind: 'idle'}});
        return;
      }
      this.update({model: {kind: 'failed', error: this.toUserError(error)}});
    }
  };

  readonly cancelDownload = (): void => {
    if (this.state.model.kind === 'downloading') void this.engine?.call('cancelDownload').catch(() => {});
  };

  /** 失敗の表示を消して、未ロードに戻す。 */
  readonly dismissFailure = (): void => {
    if (this.state.model.kind === 'failed') this.update({model: {kind: 'idle'}});
  };

  /** キャッシュ済みのモデルを削除する。読み込み中のモデルなら未ロードに戻す。 */
  readonly deleteModel = async (modelId: ModelId): Promise<void> => {
    if (this.isBusy()) return;
    const {model} = this.state;
    if (model.kind === 'ready' && model.modelId === modelId) {
      this.engine?.terminate();
      this.engine = null;
      this.update({model: {kind: 'idle'}});
    }
    const client = new InferenceClient();
    try {
      await client.call('deleteCachedModel', cacheFileName(getModel(modelId)));
      this.changeCached(modelId, false);
    } catch (error) {
      this.update({model: {kind: 'failed', error: this.toUserError(error)}});
    } finally {
      client.terminate();
    }
  };

  readonly translate = async (input: TranslationInput): Promise<void> => {
    if (!canStartTranslation(this.state) || this.isBusy()) return;
    if (!input.text.trim()) return;
    if (findReservedToken(input)) {
      this.update({translation: {kind: 'failed', output: '', error: RESERVED_TOKEN_ERROR}});
      return;
    }
    if (!isSelectedReady(this.state)) {
      // 選択中のモデルが読み込まれていなければ、読み込んでから翻訳する (保存済みのモデルに限る)。
      this.cancelFlush();
      this.update({translation: {kind: 'loading', startedAt: Date.now()}});
      await this.load();
      if (!isSelectedReady(this.state)) {
        if (this.state.translation.kind === 'loading') this.update({translation: {kind: 'idle'}});
        return;
      }
    }
    if (!this.engine) return;
    const {source, target, form} = this.state.options;
    const client = this.engine;
    const used: UsedOptions = {context: Boolean(input.context), glossary: Boolean(input.glossary?.length)};
    this.cancelFlush();
    this.update({translation: {kind: 'generating', output: '', startedAt: Date.now(), progress: null}});
    try {
      const result = await client.call('translate', {
        ...input,
        ...requestTarget(target, form, this.state.selectedModelId),
        source: source || undefined,
      });
      if (this.engine !== client) return;
      this.cancelFlush();
      this.update({translation: result.kind === 'done' ? {...result, used} : result});
    } catch (error) {
      if (this.engine !== client) return;
      this.cancelFlush();
      this.update({
        translation: {kind: 'failed', output: this.currentOutput(), error: this.toUserError(error, used)},
      });
    }
  };

  /**
   * 翻訳を止める。訳文の生成中はすぐに止まる。原文の処理中は途中で止められないので、
   * 処理が終わるまで stopping になる。
   */
  readonly stop = (): void => {
    const {translation} = this.state;
    if (translation.kind !== 'generating') return;
    void this.engine?.call('stop').catch(() => {});
    // 順番待ちの翻訳は始まっていないので、すぐに停止として返る。
    if (!this.currentOutput() && !translation.queued) {
      this.update({translation: {kind: 'stopping', output: '', startedAt: translation.startedAt}});
    }
  };

  private currentOutput(): string {
    const {translation} = this.state;
    const shown = 'output' in translation ? translation.output : '';
    return (this.pendingReplace ?? shown) + this.pendingOutput;
  }

  private cancelFlush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingOutput = '';
    this.pendingReplace = null;
    this.pendingProgress = null;
  }

  private flushOutput(): void {
    this.flushTimer = null;
    const {translation} = this.state;
    if (translation.kind !== 'generating') return;
    const output = (this.pendingReplace ?? translation.output) + this.pendingOutput;
    const progress = this.pendingProgress ?? translation.progress;
    this.pendingOutput = '';
    this.pendingReplace = null;
    this.update({translation: {...translation, output, progress}});
  }

  private handleWorkerEvent(client: InferenceClient, event: WorkerEvent): void {
    if (this.engine !== client) return;
    switch (event.event) {
      case 'downloadProgress': {
        const {model} = this.state;
        if (model.kind === 'downloading') {
          this.update({model: {...model, loadedBytes: event.loadedBytes, totalBytes: event.totalBytes}});
        }
        break;
      }
      case 'initializing': {
        const {selectedModelId, selectedContextLength, model} = this.state;
        this.update({
          model: {
            kind: 'initializing',
            modelId: model.kind === 'downloading' ? model.modelId : selectedModelId,
            contextLength: selectedContextLength,
          },
        });
        break;
      }
      case 'queued': {
        const {translation} = this.state;
        if (translation.kind === 'generating') this.update({translation: {...translation, queued: true}});
        break;
      }
      case 'started': {
        // 経過時間は、待ち終えて原文の処理を始めたときから測り直す。
        const {translation} = this.state;
        if (translation.kind === 'generating') this.update({translation: {...translation, queued: false, startedAt: Date.now()}});
        break;
      }
      case 'prompt': {
        const {translation} = this.state;
        if (translation.kind === 'generating') {
          this.update({translation: {...translation, promptTokens: event.tokens, decodeLimit: event.decodeLimit}});
        }
        break;
      }
      case 'output':
        if (event.replace) {
          this.pendingReplace = event.text;
          this.pendingOutput = '';
        } else {
          this.pendingOutput += event.text;
        }
        this.pendingProgress = event.progress;
        this.flushTimer ??= setTimeout(() => this.flushOutput(), OUTPUT_FLUSH_INTERVAL_MS);
        break;
      case 'gpuError':
        this.failEngine(client, event.outOfMemory ? GPU_ERRORS.outOfMemory : GPU_ERRORS.error);
        break;
      case 'gpuLost':
        this.failEngine(client, GPU_ERRORS.lost);
        break;
    }
  }

  /** GPU や Worker の問題が起きたら、Worker を捨ててやり直せる状態にする。 */
  private failEngine(client: InferenceClient, error: UserFacingError): void {
    if (this.engine !== client) return;
    const output = this.currentOutput();
    const {translation} = this.state;
    const translating = translation.kind === 'generating' || translation.kind === 'stopping';
    this.cancelFlush();
    client.terminate();
    this.engine = null;
    this.update({
      model: {kind: 'failed', error},
      translation: translating ? {kind: 'failed', output, error} : translation,
    });
  }

  /** used は翻訳の依頼に含めた詳細オプション (翻訳の失敗のときだけ渡す)。 */
  private toUserError(error: unknown, used?: UsedOptions): UserFacingError {
    const failure: WorkerFailure =
      error instanceof WorkerCallError
        ? error.failure
        : {code: 'unknown', message: error instanceof Error ? error.message : String(error)};
    // 詳細はコンソールに出す。原文と訳文は含まれない。
    console.error(`[plamo-translate-demo] ${failure.code}: ${failure.message}`);
    return describeFailure(failure, used);
  }
}

export const translatorStore = new TranslatorStore();
