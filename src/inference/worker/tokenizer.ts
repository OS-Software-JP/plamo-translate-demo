// プロンプトのトークン数を数える。SDK は生成が終わるまでトークン数を返さないので、自前で数える。
// pfnet/plamo-3-translate-0.8b (コミット 2c6192f7) の tokenization_plamo.py (Plamo3Tokenizer) と
// chat_template.jinja を移したもの。語彙は public/tokenizer/plamo-3-translate.jsonl (0.8B と 2B で同じファイル)。
// 元の実装と SDK の値に一致することを確かめてある (scripts/verify/tokenizer.ts、仕様書の 6.8 節)。
import type {TranslationRequest} from '../protocol';

/** 語彙にない文字のスコア。バイトのトークンに分ける。 */
const UNKNOWN_SCORE = -10_000_000;
/** 区切りの文字。前後で必ずトークンを分ける。トークン数には数えない。 */
const BOUNDARY = '';
const SPECIAL_TOKEN = /(<\|plamo:[^|\s]{0,64}\|>)/gu;
// 4 文字以上の同じ文字の繰り返し (break_around_repeated_chars_threshold) と、2 つ以上の空白
// (break_around_consecutive_spaces_threshold) の前後で区切る。Python の `.` は改行 (\n) だけを除くので [^\n] にする。
const BREAKS = /(([^\n])\2{3,}| {2,})/gu;

export interface Tokenizer {
  /** トークン (バイトのトークンを除く) と、整数にしたスコア (元の値 × 10,000)。 */
  readonly scores: Map<string, number>;
  /** 最も長いトークンの文字数 (コードポイント)。 */
  readonly maxLength: number;
}

/** 語彙のファイル (1 行に [トークン, スコア, 種類] の JSON) から作る。 */
export function createTokenizer(vocab: string): Tokenizer {
  const scores = new Map<string, number>();
  let maxLength = 1;
  for (const line of vocab.split('\n')) {
    if (!line) continue;
    const [token, score, type] = JSON.parse(line) as [string, number, string];
    // バイトのトークンは、語彙にない文字を分けるときにだけ使う。数えるだけなので ID はいらない。
    if (type === 'BYTE') continue;
    scores.set(token, Math.round(score * 1e4));
    maxLength = Math.max(maxLength, [...token].length);
  }
  scores.set(BOUNDARY, 0);
  return {scores, maxLength};
}

const utf8Length = (codePoint: number): number =>
  1 + Number(codePoint >= 0x80) + Number(codePoint >= 0x800) + Number(codePoint >= 0x10000);

/**
 * 文字列のトークン数。後ろから前へ、各位置で最もスコアのよい区切りを求める。
 * 同じスコアなら長いトークンを選ぶ (元の実装と同じ)。
 */
export function countTokens({scores, maxLength}: Tokenizer, text: string): number {
  const data = text.replace(SPECIAL_TOKEN, `${BOUNDARY}$1${BOUNDARY}`).replace(BREAKS, `${BOUNDARY}$1${BOUNDARY}`);
  const chars = Array.from(data);
  const n = chars.length;
  const cost = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY);
  const count = new Int32Array(n + 1);
  cost[n] = 0;
  const lengths: number[] = [];
  const pieceScores: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    lengths.length = 0;
    pieceScores.length = 0;
    let piece = '';
    for (let length = 1; length <= maxLength && i + length <= n; length++) {
      piece += chars[i + length - 1];
      const score = scores.get(piece);
      if (score !== undefined) {
        lengths.push(length);
        pieceScores.push(score);
      }
    }
    // 長いトークンから試し、より良いときだけ更新する (同点なら長いほうが残る)。
    for (let k = lengths.length - 1; k >= 0; k--) {
      const length = lengths[k];
      const candidate = cost[i + length] - pieceScores[k];
      if (candidate < cost[i]) {
        cost[i] = candidate;
        count[i] = count[i + length] + (length === 1 && chars[i] === BOUNDARY ? 0 : 1);
      }
    }
    const unknown = cost[i + 1] - UNKNOWN_SCORE;
    if (unknown < cost[i]) {
      cost[i] = unknown;
      count[i] = count[i + 1] + utf8Length(chars[i].codePointAt(0) ?? 0);
    }
  }
  return count[0];
}

/**
 * chat_template.jinja と同じプロンプトを組み立てる。Worker が SDK に渡す追加の情報 (extra_context) と
 * 同じ条件で項目を入れる (文体は翻訳先が日本語のときだけ)。
 */
export function buildPrompt({text, target, source, form, context, glossary}: TranslationRequest): string {
  let prompt = '<|plamo:bos|><|plamo:tag|>dataset<|plamo:msg|>translation';
  if (context) prompt += `<|plamo:tag|>context<|plamo:msg|>${context}`;
  if (glossary?.length) {
    prompt += '<|plamo:tag|>glossary';
    for (const term of glossary) prompt += `<|plamo:index|>${term.source}<|plamo:item|>${term.target}`;
  }
  prompt += '<|plamo:tag|>input';
  if (source) prompt += `<|plamo:key|>lang<|plamo:val|>${source}`;
  prompt += `<|plamo:msg|>${text}<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${target}`;
  if (form && target === 'ja') prompt += `<|plamo:key|>form<|plamo:val|>${form}`;
  return `${prompt}<|plamo:msg|>`;
}

/** 翻訳の依頼のプロンプト全体のトークン数。SDK の原文の処理のトークン数 (lastPrefillTokenCount) と一致する。 */
export const countPromptTokens = (tokenizer: Tokenizer, request: TranslationRequest): number =>
  countTokens(tokenizer, buildPrompt(request));
