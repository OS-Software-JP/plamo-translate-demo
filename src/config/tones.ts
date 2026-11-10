// 口調 (お嬢様言葉など)。使っていない予約トークンの入力埋め込み (1 行) を学習した値に差し替え、
// そのトークンを翻訳先 (target_lang) として渡すと、口調付きの日本語に訳す。ほかの重みは変えないので、
// 通常の翻訳には影響しない。モデルのファイルごとに学習した行を toneRows.ts に同梱し、読み込むときに差し込む。
import {TONE_ROWS} from './toneRows';

/**
 * 口調を使うか。訳が安定しないので、いまは文体の欄に出さず、モデルにも行を差し込まない (SPEC 6.9 節)。
 * true にすると、文体の欄に口調が戻る。
 */
export const TONES_ENABLED: boolean = false;

export type ToneId = 'ojousama' | 'mesugaki';

export interface ToneDefinition {
  id: ToneId;
  /** 文体の欄に出す名前。 */
  label: string;
  /** 翻訳先として渡す予約トークン。 */
  token: string;
  /** 予約トークンの ID (埋め込みの表の行)。 */
  tokenId: number;
}

export const TONES: readonly ToneDefinition[] = [
  {id: 'ojousama', label: 'お嬢様言葉', token: '<|plamo:reserved:0x106|>', tokenId: 0x106},
  {id: 'mesugaki', label: 'メスガキ口調', token: '<|plamo:reserved:0x107|>', tokenId: 0x107},
];

/** モデルのファイルに差し込む口調の行。 */
export interface ToneRows {
  /** 埋め込みの表 (int8、行ごとの scale) の先頭のバイト位置。 */
  embeddingOffset: number;
  /** 1 行のバイト数 (次元数)。 */
  rowBytes: number;
  /** 「ja」(1385) の行の SHA-256。ファイルが想定どおりかを、差し込む前に確かめる。 */
  checkRowSha256: string;
  /** 口調ごとの行 (int8、base64)。行の scale はファイルのまま使う。 */
  rows: Record<ToneId, string>;
}

/** 確認に使う行のトークン (「ja」)。 */
export const CHECK_TOKEN_ID = 1385;

export const isToneId = (value: unknown): value is ToneId => TONES.some(tone => tone.id === value);

export const getTone = (id: ToneId): ToneDefinition => {
  const tone = TONES.find(candidate => candidate.id === id);
  if (!tone) throw new Error(`未知の口調です: ${id}`);
  return tone;
};

/** 翻訳先が口調の予約トークンか。 */
export const isToneToken = (target: string): boolean => TONES.some(tone => tone.token === target);

/** モデル (ModelDefinition の id) の口調の行。学習していないモデルと、口調を使わないときは undefined。 */
export const toneRowsOf = (modelId: string): ToneRows | undefined => (TONES_ENABLED ? TONE_ROWS[modelId] : undefined);
