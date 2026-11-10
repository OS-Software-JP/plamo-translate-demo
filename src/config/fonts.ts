// 明朝体を使うのは日本語と欧文 (ラテン文字の言語) だけ。それ以外は OS 標準のフォントで表示する。
const LATIN_SCRIPT_LANGUAGES = new Set([
  'en',
  'az',
  'ca',
  'ceb',
  'de',
  'es',
  'et',
  'eu',
  'fr',
  'hr',
  'hu',
  'id',
  'it',
  'jv',
  'lt',
  'lv',
  'ms',
  'nl',
  'pl',
  'sk',
  'sl',
  'sw',
  'tl',
  'uz',
  'vi',
]);

const hasBundledFont = (language: string): boolean => language === 'ja' || LATIN_SCRIPT_LANGUAGES.has(language);

/** 訳文の本文のフォント。 */
export const outputFontClass = (language: string): string => (hasBundledFont(language) ? 'font-serif' : 'font-os');

/** 原文の本文のフォント。訳文と揃えて明朝体にする。自動判定 (空文字) のときも明朝体を使う。 */
export const sourceFontClass = (language: string): string =>
  language === '' || hasBundledFont(language) ? 'font-serif' : 'font-os';
