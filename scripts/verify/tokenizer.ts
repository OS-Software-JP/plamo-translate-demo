// 自前のトークナイザー (src/inference/worker/tokenizer.ts) を、元の実装 (Python) の結果と照合する。
//   bun run verify:tokenizer
// 参照データの prompt と prompt_ids (元の実装で作ったプロンプトとトークン ID) に、組み立てたプロンプトとトークン数が一致するか。
// 参照データの場所は PLAMO_REFERENCE_DIR で変えられる。
import {readFileSync} from 'node:fs';
import {buildPrompt, countTokens, createTokenizer} from '../../src/inference/worker/tokenizer';

interface ReferenceItem {
  name?: string;
  text: string;
  source_lang?: string;
  target_lang: string;
  form?: 'polite' | 'plain';
  context?: string;
  glossary?: Array<{source: string; target: string}>;
  prompt?: string;
  prompt_ids?: number[];
}

const REFERENCE_DIR = process.env.PLAMO_REFERENCE_DIR ?? 'D:/works/AI/LiteRT-LM/web/tests';
const startedAt = performance.now();
const tokenizer = createTokenizer(readFileSync('public/tokenizer/plamo-3-translate.jsonl', 'utf8'));
console.log(`語彙 ${tokenizer.scores.size} 件、最長 ${tokenizer.maxLength} 文字、読み込み ${Math.round(performance.now() - startedAt)} ms`);

let total = 0;
let failures = 0;
for (const file of ['reference_outputs', 'reference_beyond', 'reference_far']) {
  const items = JSON.parse(readFileSync(`${REFERENCE_DIR}/${file}.json`, 'utf8')) as ReferenceItem[];
  for (const item of items) {
    if (!item.prompt || !item.prompt_ids) continue;
    total++;
    const prompt = buildPrompt({
      text: item.text,
      target: item.target_lang,
      source: item.source_lang,
      form: item.form,
      context: item.context,
      glossary: item.glossary,
    });
    const countedAt = performance.now();
    const tokens = countTokens(tokenizer, item.prompt);
    const ms = performance.now() - countedAt;
    const ok = prompt === item.prompt && tokens === item.prompt_ids.length;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${file} ${item.name ?? item.text.slice(0, 16)}: ${tokens} / ${item.prompt_ids.length} トークン、` +
        `プロンプト${prompt === item.prompt ? '一致' : '不一致'}、${ms.toFixed(1)} ms`,
    );
  }
}
console.log(`\n${total - failures}/${total} passed`);
process.exitCode = failures === 0 && total > 0 ? 0 : 1;
