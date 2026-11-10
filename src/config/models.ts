export const CONTEXT_LENGTHS = [2048, 8192, 32768] as const;
export type ContextLength = (typeof CONTEXT_LENGTHS)[number];
export const DEFAULT_CONTEXT_LENGTH: ContextLength = 8192;

export type ModelId = '0.8b-int8' | '0.8b-int4' | '2b-int8' | '2b-int4' | '8b-int8' | '8b-int4';

export interface ModelDefinition {
  id: ModelId;
  /** 表示名。ライセンス第 4 条により「PLaMo」を含める。 */
  label: string;
  fileName: string;
  /** ファイルの配信元。 */
  baseUrl: string;
  /** 進捗の分母と、保存後の一致確認に使う。 */
  sizeBytes: number;
  /** キャッシュキーの一部。ファイルを差し替えたら変える。 */
  revision: string;
  /** 最大の重みである埋め込みの表のバイト数 (語彙数 × 次元数)。 */
  largestBufferBytes: number;
  /**
   * 読み込みと短文の翻訳の後に増えた GPU メモリの実測値 (表示用)。0.8B と 2B は Intel の内蔵 GPU の共有メモリ、
   * 8B は RTX 3090 の専用メモリで測った。
   */
  gpuMemoryGiB: Record<ContextLength, number>;
}

const REVISION = '20261106';
// 0.8B、2B、8B は Hugging Face のリポジトリが別なので、配信元も別に指定する。省略すると /models から取得する。
const BASE_URL_0_8B: string = import.meta.env.VITE_MODEL_BASE_URL_0_8B ?? '/models';
const BASE_URL_2B: string = import.meta.env.VITE_MODEL_BASE_URL_2B ?? '/models';
const BASE_URL_8B: string = import.meta.env.VITE_MODEL_BASE_URL_8B ?? '/models';
const EMBEDDING_0_8B_BYTES = 107520 * 1536;
const EMBEDDING_2B_BYTES = 107520 * 2560;
const EMBEDDING_8B_BYTES = 107520 * 4096;

export const MODELS: readonly ModelDefinition[] = [
  {
    id: '0.8b-int8',
    label: 'PLaMo 3 Translate 0.8B int8',
    fileName: 'plamo-3-translate-0.8b-int8.litertlm',
    baseUrl: BASE_URL_0_8B,
    sizeBytes: 913014784,
    revision: REVISION,
    largestBufferBytes: EMBEDDING_0_8B_BYTES,
    gpuMemoryGiB: {2048: 1.9, 8192: 2.08, 32768: 2.53},
  },
  {
    id: '0.8b-int4',
    label: 'PLaMo 3 Translate 0.8B int4',
    // QAT (量子化を意識した学習) で重みを調整した int4。大きさは学習なしの int4 と同じ。2B に QAT 版はない。
    fileName: 'plamo-3-translate-0.8b-int4-qat.litertlm',
    baseUrl: BASE_URL_0_8B,
    sizeBytes: 581763072,
    revision: REVISION,
    largestBufferBytes: EMBEDDING_0_8B_BYTES,
    gpuMemoryGiB: {2048: 1.28, 8192: 1.47, 32768: 1.91},
  },
  {
    id: '2b-int8',
    label: 'PLaMo 3 Translate 2B int8',
    fileName: 'plamo-3-translate-2b-int8.litertlm',
    baseUrl: BASE_URL_2B,
    sizeBytes: 2918809600,
    revision: REVISION,
    largestBufferBytes: EMBEDDING_2B_BYTES,
    gpuMemoryGiB: {2048: 5.74, 8192: 6.28, 32768: 8.76},
  },
  {
    id: '2b-int4',
    label: 'PLaMo 3 Translate 2B int4',
    fileName: 'plamo-3-translate-2b-int4.litertlm',
    baseUrl: BASE_URL_2B,
    sizeBytes: 1750450176,
    revision: REVISION,
    largestBufferBytes: EMBEDDING_2B_BYTES,
    gpuMemoryGiB: {2048: 3.75, 8192: 4.28, 32768: 6.75},
  },
  {
    id: '8b-int8',
    label: 'PLaMo 3 Translate 8B int8',
    fileName: 'plamo-3-translate-8b-int8.litertlm',
    baseUrl: BASE_URL_8B,
    sizeBytes: 8601796608,
    revision: REVISION,
    largestBufferBytes: EMBEDDING_8B_BYTES,
    gpuMemoryGiB: {2048: 16.2, 8192: 16.9, 32768: 19.96},
  },
  {
    id: '8b-int4',
    label: 'PLaMo 3 Translate 8B int4',
    fileName: 'plamo-3-translate-8b-int4.litertlm',
    baseUrl: BASE_URL_8B,
    sizeBytes: 5005131776,
    revision: REVISION,
    largestBufferBytes: EMBEDDING_8B_BYTES,
    gpuMemoryGiB: {2048: 10.0, 8192: 10.75, 32768: 13.81},
  },
];

// いちばん小さく速い 0.8B int4 (QAT 版) を既定にする。
export const DEFAULT_MODEL_ID: ModelId = '0.8b-int4';

export function getModel(id: ModelId): ModelDefinition {
  const model = MODELS.find(candidate => candidate.id === id);
  if (!model) throw new Error(`未知のモデルです: ${id}`);
  return model;
}

export const isModelId = (value: unknown): value is ModelId => MODELS.some(model => model.id === value);

export const isContextLength = (value: unknown): value is ContextLength =>
  CONTEXT_LENGTHS.some(length => length === value);

/** OPFS に保存するときのファイル名。 */
export const cacheFileName = (model: ModelDefinition): string => `${model.revision}_${model.fileName}`;

/** モデルのダウンロード先。Worker では import.meta を使わないので、主スレッドで組み立てて渡す。 */
export const modelUrl = (model: ModelDefinition): string => `${model.baseUrl}/${model.fileName}`;

/** プロンプトのトークン数を数えるための語彙 (pfnet/plamo-3-translate-0.8b の tokenizer.jsonl、2B と 8B も同じ)。 */
export const tokenizerUrl = (): string =>
  new URL(`${import.meta.env.BASE_URL}tokenizer/plamo-3-translate.jsonl`, location.origin).href;

/** WASM の配信場所。Worker には主スレッドから渡す。 */
export const wasmBaseUrl = (): string => new URL(`${import.meta.env.BASE_URL}litert-wasm/`, location.origin).href;
