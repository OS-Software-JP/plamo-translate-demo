// 複数のタブで Engine を共有できるかを、実際のモデルで確かめる。
//   bun run verify:tabs
// 同じモデルとコンテキスト長を選んだタブは 1 つの SharedWorker (1 つの Engine) を使い、GPU のメモリは増えない。
// どのタブも使わなくなった Engine は終了して、メモリを解放する。
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT, openChrome, sleep, startProcess, waitForHttp} from './browser.mjs';

const PAGE = 'http://127.0.0.1:5196/';
const HARD_LIMIT_MS = 15 * 60 * 1000;
const REFERENCE_DIR = process.env.PLAMO_REFERENCE_DIR ?? 'D:/works/AI/LiteRT-LM/web/tests';
const shortRef = JSON.parse(readFileSync(`${REFERENCE_DIR}/reference_outputs.json`, 'utf8'));
const store = 'window.plamoTranslator';
const INT8_8192_GIB = 2.08;

const results = [];
function check(name, ok, detail) {
  results.push({name, ok, detail});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
}

async function startTranslate(tab, item) {
  const options = {source: item.source_lang ?? '', target: item.target_lang, form: item.form ?? ''};
  const input = {text: item.text, context: item.context, glossary: item.glossary};
  await tab.evaluate(`${store}.setOptions(${JSON.stringify(options)}); void ${store}.translate(${JSON.stringify(input)}); null`);
}

const finished = tab => tab.waitState(`!['idle', 'loading', 'generating', 'stopping'].includes(v.translation.kind)`);

async function loadIn(tab, modelId, contextLength) {
  await tab.evaluate(`${store}.selectModel(${JSON.stringify(modelId)}); ${store}.selectContextLength(${contextLength})`);
  await tab.evaluate(`void ${store}.load(); null`);
  return tab.waitState(`v.model.kind === 'ready' || v.model.kind === 'failed'`);
}

async function openApp(chrome) {
  const tab = await chrome.openTab(PAGE);
  await tab.waitState(`v.model.kind !== 'checking'`, 60000);
  return tab;
}

/** 少し待ってから測る。終了した Worker のメモリが解放されるまで時間がかかる。 */
async function memory(chrome) {
  await sleep(2500);
  return +(await chrome.gpuMemoryGiB()).toFixed(2);
}

let chrome;
let server;
const hardLimit = setTimeout(async () => {
  console.log(`FAIL  時間切れ (${HARD_LIMIT_MS / 60000} 分)`);
  await chrome?.close().catch(() => {});
  server?.stop();
  process.exit(2);
}, HARD_LIMIT_MS);

try {
  const build = startProcess('bun run build --mode verify --outDir .verify/dist --emptyOutDir');
  if ((await build.exited) !== 0) throw new Error(build.lines.join('\n'));
  server = startProcess('bun run preview --mode verify --outDir .verify/dist --port 5196 --strictPort --host 127.0.0.1');
  await waitForHttp(PAGE);
  chrome = await openChrome('verify-tabs');
  console.log(`browser: ${chrome.version.product}`);

  // タブ A で読み込む (初回なのでダウンロードする)。
  const tabA = await openApp(chrome);
  const baseline = await memory(chrome);
  let state = await loadIn(tabA, '0.8b-int8', 8192);
  check('タブ A で読み込める', state.model.kind === 'ready', {loadSeconds: state.model.loadSeconds});
  const memoryA = await memory(chrome);

  // タブ B で同じ設定を読み込む。A の Engine を使うので、すぐに準備完了になる。
  const tabB = await openApp(chrome);
  state = await tabB.evaluate(`${store}.getSnapshot()`);
  check('タブ B でも保存済みと分かる', state.cachedModelIds.includes('0.8b-int8'));
  state = await loadIn(tabB, '0.8b-int8', 8192);
  check('タブ B は A の Engine を使い、すぐに準備完了になる', state.model.kind === 'ready' && state.model.loadSeconds < 0.5, {loadSeconds: state.model.loadSeconds});
  const memoryAB = await memory(chrome);
  check('2 つのタブで同じ設定を読み込んでも GPU メモリは増えない', memoryAB - memoryA < 0.5, {baseline, memoryA, memoryAB});

  // 同時に翻訳する。届いた順に 1 件ずつ処理し、訳文はそれぞれのタブに届く。
  await startTranslate(tabA, shortRef[0]);
  await startTranslate(tabB, shortRef[1]);
  // B は A の翻訳が終わるのを待つ。待ち終えたら経過時間を測り直す。
  const traceB = tabB.evaluate(`new Promise(resolve => {
    const store = ${store};
    const seen = [];
    const record = () => {
      const t = store.getSnapshot().translation;
      if (t.kind === 'generating') {
        const pane = document.querySelector('section[aria-label="訳文"]').innerText;
        seen.push({queued: t.queued === true, startedAt: t.startedAt, waitingText: pane.includes('別のタブの翻訳が終わるのを待っています')});
      } else if (t.kind !== 'idle') {
        unsubscribe();
        resolve(seen);
      }
    };
    const unsubscribe = store.subscribe(() => setTimeout(record, 0));
    record();
  })`);
  const [doneA, doneB] = await Promise.all([finished(tabA), finished(tabB)]);
  const seenB = await traceB;
  const queuedEntry = seenB.find(entry => entry.queued);
  const startedEntry = seenB.find(entry => !entry.queued && queuedEntry && entry.startedAt > queuedEntry.startedAt);
  check('待っている間は、訳文の欄に順番待ちの案内を出す', Boolean(queuedEntry?.waitingText), {states: seenB.length});
  check('待ち終えたら案内を消し、経過時間を測り直す', Boolean(startedEntry) && !startedEntry.waitingText);
  check(
    '同時に翻訳しても、それぞれの訳文が参照と一致する',
    doneA.translation.output === shortRef[0].output && doneB.translation.output === shortRef[1].output,
    {a: doneA.translation.kind, b: doneB.translation.kind},
  );

  // 順番待ちの翻訳を止める。A の翻訳は続く。
  const longItem = {...shortRef[0], text: Array.from({length: 12}, (_, i) => shortRef[i % shortRef.length].text).join('\n')};
  await startTranslate(tabA, longItem);
  await tabA.waitState(`v.translation.kind === 'generating'`, 10000);
  await startTranslate(tabB, shortRef[2]);
  await tabB.waitState(`v.translation.kind === 'generating'`, 10000);
  await tabB.evaluate(`${store}.stop()`);
  const stoppedB = await finished(tabB);
  const stillA = await tabA.evaluate(`${store}.getSnapshot().translation.kind`);
  check('順番待ちの翻訳は、ほかのタブの翻訳を待たずに止められる', stoppedB.translation.kind === 'stopped' && stillA === 'generating', {b: stoppedB.translation.kind, a: stillA});
  const longA = await finished(tabA);
  check('ほかのタブが止めても、翻訳は最後まで続く', longA.translation.kind === 'done' && longA.translation.output.length > 0, {a: longA.translation.kind});

  // A を閉じても、B は同じ Engine で翻訳を続けられる。
  await tabA.close();
  await sleep(1000);
  await startTranslate(tabB, shortRef[0]);
  const afterClose = await finished(tabB);
  check('タブ A を閉じても、タブ B は翻訳できる', afterClose.translation.output === shortRef[0].output);

  // B が別のモデルに切り替えると、どのタブも使わなくなった Engine は終了する。
  const tabC = await openApp(chrome);
  state = await loadIn(tabB, '0.8b-int4', 8192);
  check('タブ B は別のモデルに切り替えられる', state.model.kind === 'ready' && state.model.modelId === '0.8b-int4');
  const memorySwitched = await memory(chrome);
  // 0.8B int8 (8192) の Engine が残っていれば、int4 の分だけ増える。解放されていれば、int8 と int4 の差だけ減る。
  check('どのタブも使わなくなった Engine は終了し、GPU メモリが解放される', memorySwitched < memoryAB - 0.3, {memoryAB, memorySwitched, int8: INT8_8192_GIB});
  state = await tabC.evaluate(`${store}.getSnapshot()`);
  check('ほかのタブでダウンロードしたモデルも、保存済みと表示される', state.cachedModelIds.includes('0.8b-int4'));

  // C で int8 を読み込むと、新しい Engine を作る (終了した Engine は使わない)。
  state = await loadIn(tabC, '0.8b-int8', 8192);
  check('終了した Engine の代わりに、新しい Engine を作って読み込む', state.model.kind === 'ready' && state.model.loadSeconds > 0.5, {loadSeconds: state.model.loadSeconds});
  await startTranslate(tabC, shortRef[1]);
  const fromC = await finished(tabC);
  check('新しい Engine で翻訳できる', fromC.translation.output === shortRef[1].output);

  check('未処理の例外がない', chrome.observed.exceptions.length === 0, chrome.observed.exceptions.slice(0, 3));
  check('エラーのログがない', !chrome.observed.console.some(entry => entry.type === 'error'), chrome.observed.console.filter(entry => entry.type === 'error').slice(0, 3));
} catch (error) {
  check('実行エラー', false, String(error?.stack ?? error));
} finally {
  clearTimeout(hardLimit);
  await chrome?.close();
  server?.stop();
  writeFileSync(resolve(ROOT, '.verify', 'result-tabs.json'), JSON.stringify(results, null, 2));
  const passed = results.filter(result => result.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}
