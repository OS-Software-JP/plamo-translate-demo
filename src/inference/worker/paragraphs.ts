// 口調付きの翻訳を段落ごとに分ける (6.9 節)。口調の行 (予約トークン 1 つ) の効き目は長い訳文の終わりまで届きにくいので、
// 空行で区切った段落を 1 つずつ別に訳してつなぐ。

/** 段落の区切り。空行 (空白だけの行を含む) と、その後に続く空白。 */
const PARAGRAPH_BREAK = /(\r?\n[^\S\n]*\n\s*)/;

export interface Paragraph {
  /** 訳す段落 (空白だけの段落は含めない)。 */
  text: string;
  /** 訳文で段落の後に置く区切り (原文の空行のまま。次の段落の字下げは除く)。最後の段落は空。 */
  separator: string;
}

/** 原文を空行で段落に分ける。1 行の改行 (見出しの行など) では分けない。 */
export function splitParagraphs(text: string): Paragraph[] {
  const pieces = text.split(PARAGRAPH_BREAK);
  const paragraphs: Paragraph[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    if (!pieces[i].trim()) continue;
    paragraphs.push({text: pieces[i], separator: (pieces[i + 1] ?? '').replace(/[^\S\n]+$/, '')});
  }
  if (paragraphs.length) paragraphs[paragraphs.length - 1].separator = '';
  return paragraphs;
}
