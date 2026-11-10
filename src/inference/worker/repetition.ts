// 口調付きの翻訳で、生成が止まらずに同じ並びを繰り返し始めたことを見つける。口調の行は学習で作ったもので、
// まれに文を言い終えても終わりの記号を出さず、同じ文字や文を繰り返し続けることがあるため。

/** 1〜8 文字の並びが 12 回以上続く (例: 「ይይይ…」「〇〇♡ 〇〇♡ …」)。意味のない文字や記号の連続。 */
const SHORT_REPEAT = /(.{1,8}?)\1{11,}$/su;
/** 9〜80 文字の並び (文) が 3 回以上続く。 */
const LONG_REPEAT = /(.{9,80}?)\1{2,}$/su;
/** 調べる末尾の文字数。 */
const WINDOW = 400;

/**
 * 正しい文字にならないバイトのトークンを出し続けると、SDK はチャンクを返さないまま上限まで生成し、
 * 最後に文字化け (U+FFFD) をまとめて返す (0.8B int4、実測)。最初の出力の後、この時間チャンクが届かなければ
 * 止まらない繰り返しとみなす。通常はトークンごとにチャンクが届く (1 トークン数十 ms)。
 */
export const NO_CHUNK_TIMEOUT_MS = 4000;

/** 文字を返さない生成 (空のチャンク) がこの回数続いたら、止まらない繰り返しとみなす。 */
export const MAX_EMPTY_CHUNKS = 24;

/**
 * 訳文の末尾に続く、日本語の訳では使わない文字 (ベンガル文字、エチオピア文字など)。口調付きの訳は日本語なので、
 * 文を言い終えた後に出る文字化けの断片とみなす (例:「…ありますかন্দ্রন্দ্র」)。漢字、かな、ラテン文字、
 * ハングル、ギリシャ文字、キリル文字、記号と数字 (Common) は残す。
 */
const FOREIGN_TAIL =
  /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Latin}\p{Script=Hangul}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}\s]+$/u;

/** 末尾の、日本語の訳では使わない文字の並びを除く。 */
export const trimForeignTail = (text: string): string => text.replace(FOREIGN_TAIL, '');

/**
 * 末尾が止まらない繰り返しなら、残す長さを返す。そうでなければ null。短い並びの繰り返しは全部除き、
 * 文の繰り返しは最初の 1 回だけを残す。生成中に毎回呼ぶので、末尾だけを調べる。
 */
export function runawayRepeatEnd(text: string): number | null {
  const start = Math.max(0, text.length - WINDOW);
  const tail = text.slice(start);
  const short = SHORT_REPEAT.exec(tail);
  if (short) {
    // 繰り返しが調べた範囲より前から続いていれば (まとめて届いたとき)、さかのぼって全部除く。
    const unit = short[1];
    let end = start + short.index;
    while (end >= unit.length && text.startsWith(unit, end - unit.length)) end -= unit.length;
    return end;
  }
  const long = LONG_REPEAT.exec(tail);
  if (long) return start + long.index + long[1].length;
  return null;
}
