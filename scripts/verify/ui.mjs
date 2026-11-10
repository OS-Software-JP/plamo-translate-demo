// 実際のモデルで画面を操作して確かめる。ボタンを押し、表示された内容で判定する。
//   bun run verify:ui
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT, TONES_ENABLED, openChrome, sleep, startProcess, waitForHttp} from './browser.mjs';

const REFERENCE_DIR = process.env.PLAMO_REFERENCE_DIR ?? 'D:/works/AI/LiteRT-LM/web/tests';
const reference = name => JSON.parse(readFileSync(`${REFERENCE_DIR}/${name}.json`, 'utf8'));
const shortRef = reference('reference_outputs');
const far = reference('reference_far');
const beyond = reference('reference_beyond');
const farX2 = far.find(item => item.name === 'far_x2');
const longInput = beyond.find(item => item.name === 'beyond_whole_en_ja');
const PAGE = 'http://127.0.0.1:5198/';

const results = [];
function check(name, ok, detail) {
  results.push({name, ok, detail});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
}

// ページの中で使う補助関数。
const HELPERS = `
  window.__ui = {
    button(name) {
      return [...document.querySelectorAll('button')].find(b => b.textContent.trim() === name || b.getAttribute('aria-label') === name);
    },
    click(name) {
      const b = this.button(name);
      if (!b) throw new Error('button not found: ' + name);
      if (b.disabled) throw new Error('button disabled: ' + name);
      b.click();
    },
    select(label) {
      return [...document.querySelectorAll('label')].find(l => l.textContent.trim().startsWith(label))?.querySelector('select');
    },
    choose(label, value) {
      const el = this.select(label);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('change', {bubbles: true}));
    },
    setValue(el, value) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', {bubbles: true}));
    },
    // 翻訳の欄の最初の textarea が原文 (参考文脈の textarea は後ろにある)。
    source() { return document.querySelector('section[aria-label="翻訳"] textarea'); },
    outputPane() { return document.querySelector('section[aria-label="訳文"]'); },
    output() { return this.outputPane().querySelector('p[aria-live]')?.textContent ?? ''; },
    text() { return document.body.innerText; },
  };
`;

const ui = (chrome, code) => chrome.evaluate(`(() => { const ui = window.__ui; return ${code}; })()`);
const click = (chrome, name) => ui(chrome, `ui.click(${JSON.stringify(name)})`);
const setSource = (chrome, text) => ui(chrome, `ui.setValue(ui.source(), ${JSON.stringify(text)})`);
const setContext = (chrome, text) =>
  chrome.evaluate(`(() => {
    const details = document.querySelector('details');
    details.open = true;
    window.__ui.setValue(details.querySelector('textarea'), ${JSON.stringify(text)});
  })()`);

async function waitUi(chrome, code, timeoutMs = 120000, label = code) {
  const startedAt = Date.now();
  for (;;) {
    if (await chrome.evaluate(`(() => { const ui = window.__ui; return Boolean(${code}); })()`)) return Date.now() - startedAt;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`UI timeout: ${label}`);
    await sleep(25);
  }
}

const ready = chrome => waitUi(chrome, `ui.text().includes('準備完了') && ui.button('翻訳する')`, 240000, 'ready');
// 翻訳と停止は 1 つのボタンで切り替わる。「翻訳する」に戻れば翻訳は終わっている。
const idleAfterTranslate = chrome => waitUi(chrome, `ui.button('翻訳する') && !ui.outputPane().querySelector('.loading')`);
const metricsOf = (chrome, label) =>
  ui(chrome, `document.querySelector('[role=group][aria-label=${JSON.stringify(label)}]')?.innerText.trim() ?? ''`);

async function open(chrome) {
  await chrome.navigate(PAGE);
  await chrome.evaluate(HELPERS);
}

async function run(chrome) {
  await chrome.setViewport(1536, 1024);
  await open(chrome);
  await waitUi(chrome, `!ui.text().includes('確認しています')`, 60000);

  // 初回訪問。
  let text = await ui(chrome, 'ui.text()');
  check('Built with PLaMo を表示する', text.includes('Built with PLaMo'));
  check('生成物である旨を表示する', text.includes('翻訳結果は PLaMo 3 Translate (LiteRT-LM 版) の生成物です'));
  check('モデル名に PLaMo を含む', await ui(chrome, `ui.select('モデル').selectedOptions[0].textContent.includes('PLaMo')`));
  check('ダウンロードの近くにライセンスの案内がある', text.includes('PLaMo コミュニティライセンス が適用されます'));
  check('初回はダウンロードのボタンが出る', await ui(chrome, `Boolean(ui.button('ダウンロードして読み込む'))`));
  check('読み込むまで翻訳できない', await ui(chrome, `ui.button('翻訳する').disabled`));
  check('翻訳元は自動と 53 言語', (await ui(chrome, `ui.select('翻訳元').options.length`)) === 54);
  check('翻訳先は 53 言語', (await ui(chrome, `ui.select('翻訳先').options.length`)) === 53);
  check('コンテキスト長の既定は 8192', (await ui(chrome, `ui.select('コンテキスト長').value`)) === '8192');
  const licenseOk = await chrome.evaluate(`Promise.all([...document.querySelectorAll('footer a')].map(a => fetch(a.href).then(r => r.ok))).then(r => r.length === 2 && r.every(Boolean))`);
  check('フッターのライセンスのリンクを開ける', licenseOk);

  // ダウンロードと読み込み。
  await click(chrome, 'ダウンロードして読み込む');
  await ready(chrome);
  text = await ui(chrome, 'ui.text()');
  check('読み込むと準備完了になり、保存済みと表示する', text.includes('保存済み'));
  check('読み込みの秒数を表示する', /読み込み \d+\.\d 秒/.test(text));

  // 空の入力。
  check('原文が空なら翻訳できない', await ui(chrome, `ui.button('翻訳する').disabled`));
  check('原文が空なら消去のボタンは押せない', await ui(chrome, `ui.button('原文を消去').disabled`));

  // 翻訳。
  const item = shortRef.find(entry => entry.source_lang === 'en' && entry.target_lang === 'ja' && !entry.context && !entry.glossary && !entry.form) ?? shortRef[0];
  await ui(chrome, `ui.choose('翻訳元', ${JSON.stringify(item.source_lang)})`);
  await ui(chrome, `ui.choose('翻訳先', ${JSON.stringify(item.target_lang)})`);
  await setSource(chrome, item.text);
  await click(chrome, '翻訳する');
  await idleAfterTranslate(chrome);
  const output = await ui(chrome, 'ui.output()');
  check('訳文が参照と一致して表示される', output === item.output, {output: output.slice(0, 40)});
  const prefillMetrics = await metricsOf(chrome, '原文の処理');
  const decodeMetrics = await metricsOf(chrome, '訳文の生成');
  check('原文の欄に原文の処理の計測値を表示する', /^[\d,]+ tokens\s+\d+\.\d+s\s+[\d,]+\.\d+ t\/s$/.test(prefillMetrics), prefillMetrics);
  check(
    '原文の欄の秒数は、最初の出力までの時間だと示す',
    await ui(chrome, `Boolean(document.querySelector('[role=group][aria-label="原文の処理"] [title="最初の出力までの時間"]'))`),
  );
  // 原文の欄の速度は実測 (トークン数 ÷ 最初の出力までの秒数)。表示は丸めてあるので、少しの差は許す。
  const [prefillTokensShown, prefillSecondsShown, prefillSpeedShown] = (prefillMetrics.match(/^([\d,]+) tokens\s+([\d.]+)s\s+([\d,.]+) t\/s$/) ?? [])
    .slice(1)
    .map(value => Number(value.replaceAll(',', '')));
  check(
    '原文の欄の速度は、トークン数 ÷ 最初の出力までの秒数',
    Math.abs(prefillSpeedShown * prefillSecondsShown - prefillTokensShown) <= prefillTokensShown * 0.05 + 1,
    {tokens: prefillTokensShown, seconds: prefillSecondsShown, speed: prefillSpeedShown},
  );
  check('訳文の欄に生成したトークン数と上限を表示する', /^[\d,]+ \/ [\d,]+ tokens\s+\d+\.\d+s\s+[\d,]+\.\d+ t\/s$/.test(decodeMetrics), decodeMetrics);
  // 速度は実測なので、速度 × 秒数がトークン数に近い (最初のトークンと終わりの記号の分、少し少ない)。
  const [decodeTokensShown, decodeLimitShown, decodeSecondsShown, decodeSpeedShown] = (
    decodeMetrics.match(/^([\d,]+) \/ ([\d,]+) tokens\s+([\d.]+)s\s+([\d,.]+) t\/s$/) ?? []
  )
    .slice(1)
    .map(value => Number(value.replaceAll(',', '')));
  check('訳文の欄の上限は、コンテキスト長から原文のトークン数を引いた残り', decodeLimitShown === 8192 - prefillTokensShown, {
    limit: decodeLimitShown,
    prefill: prefillTokensShown,
  });
  check(
    '訳文の欄のトークン数、秒数、速度のつじつまが合う',
    Math.abs(decodeSpeedShown * decodeSecondsShown - decodeTokensShown) <= 3,
    {tokens: decodeTokensShown, seconds: decodeSecondsShown, speed: decodeSpeedShown},
  );
  check('コピーのボタンが有効になる', await ui(chrome, `!ui.button('訳文をコピー').disabled`));

  // フォント。
  const family = selector => chrome.evaluate(`getComputedStyle(${selector}).fontFamily`);
  check('訳文 (日本語) は明朝体', (await family(`window.__ui.outputPane().querySelector('p[aria-live]')`)).includes('Noto Serif JP'));
  check('見出しは明朝体', (await family(`document.querySelector('h1')`)).includes('Source Serif 4'));
  check('原文の欄は明朝体', (await family(`window.__ui.source()`)).includes('Source Serif 4'));
  check('操作部はゴシック体', (await family(`window.__ui.select('モデル')`)).includes('Inter'));
  check('翻訳先の言語を lang に指定する', (await ui(chrome, `ui.outputPane().querySelector('p[aria-live]').lang`)) === 'ja');

  // 原文の消去。原文だけを消し、訳文は残す。消した後はそのまま入力できる。
  await click(chrome, '原文を消去');
  await waitUi(chrome, `ui.source().value === ''`, 5000);
  check('原文を消去すると、入力欄にフォーカスが移る', await ui(chrome, `document.activeElement === ui.source()`));
  check('原文を消去すると、翻訳と消去のボタンは押せない', await ui(chrome, `ui.button('翻訳する').disabled && ui.button('原文を消去').disabled`));
  check('原文を消去しても、訳文は残る', (await ui(chrome, 'ui.output()')) === output);

  for (const [code, expected, label] of [
    ['en', 'Source Serif 4', '欧文は明朝体'],
    ['zh-hans', 'system-ui', '中国語は OS 標準のフォント'],
    ['ar', 'system-ui', 'アラビア語は OS 標準のフォント'],
  ]) {
    await ui(chrome, `ui.choose('翻訳先', ${JSON.stringify(code)})`);
    await setSource(chrome, code === 'en' ? '今日は天気がいいです。' : 'The weather is nice today.');
    await ui(chrome, `ui.choose('翻訳元', ${JSON.stringify(code === 'en' ? 'ja' : 'en')})`);
    await click(chrome, '翻訳する');
    await idleAfterTranslate(chrome);
    const translated = await ui(chrome, 'ui.output()');
    const font = await family(`window.__ui.outputPane().querySelector('p[aria-live]')`);
    check(label, font.replaceAll('"', '').startsWith(expected), {font: font.slice(0, 40), output: translated.slice(0, 30)});
  }
  check('翻訳先が日本語以外では、文体の欄は残り、選べない', await ui(chrome, `Boolean(ui.select('文体')) && ui.select('文体').disabled`));
  await ui(chrome, `ui.choose('翻訳先', 'ja')`);
  check('翻訳先を日本語に戻すと文体を選べる', await ui(chrome, `!ui.select('文体').disabled`));
  const formOptions = await ui(chrome, `[...ui.select('文体').options].map(option => option.value + ':' + option.textContent).join(',')`);
  if (TONES_ENABLED) {
    check(
      '文体は指定なし、敬体、常体、やさしい日本語、口調 (お嬢様言葉、メスガキ口調)',
      formOptions === ':指定なし,polite:敬体,plain:常体,easy:やさしい日本語,ojousama:お嬢様言葉,mesugaki:メスガキ口調',
    );

    // 口調は 0.8B だけ。2B を選ぶと選べなくなり「指定なし」と表示し、0.8B に戻すと選んでいた口調に戻る。
    await ui(chrome, `ui.choose('文体', 'ojousama')`);
    const modelBefore = await chrome.evaluate('window.plamoTranslator.getSnapshot().selectedModelId');
    await chrome.evaluate(`window.plamoTranslator.selectModel('2b-int4')`);
    await waitUi(chrome, `ui.select('文体').querySelector('optgroup').label === '口調 (0.8B のみ)'`, 5000);
    check(
      '2B では口調を選べず、文体の欄は指定なしと表示する',
      await ui(
        chrome,
        `ui.select('文体').value === '' && [...ui.select('文体').options].filter(o => o.disabled).map(o => o.value).join() === 'ojousama,mesugaki'`,
      ),
    );
    await chrome.evaluate(`window.plamoTranslator.selectModel(${JSON.stringify(modelBefore)})`);
    await waitUi(chrome, `ui.select('文体').querySelector('optgroup').label === '口調'`, 5000);
    check('0.8B に戻すと、選んでいた口調に戻る', (await ui(chrome, `ui.select('文体').value`)) === 'ojousama');
    await ui(chrome, `ui.choose('文体', '')`);
  } else {
    check(
      '文体は指定なし、敬体、常体、やさしい日本語 (口調は出さない)',
      formOptions === ':指定なし,polite:敬体,plain:常体,easy:やさしい日本語' &&
        (await ui(chrome, `ui.select('文体').querySelector('optgroup') === null`)),
      {formOptions},
    );
  }

  // 入れ替え。選んだ文体は、入れ替えて戻すと元に戻る。
  await ui(chrome, `ui.choose('翻訳元', 'en')`);
  await ui(chrome, `ui.choose('文体', 'polite')`);
  await click(chrome, '翻訳元と翻訳先を入れ替える');
  check('翻訳元と翻訳先を入れ替えられる', (await ui(chrome, `ui.select('翻訳元').value + '>' + ui.select('翻訳先').value`)) === 'ja>en');
  check('入れ替えても文体の欄は消えない', await ui(chrome, `Boolean(ui.select('文体')) && ui.select('文体').disabled`));
  await click(chrome, '翻訳元と翻訳先を入れ替える');
  check('入れ替えて戻すと、選んだ文体に戻る', (await ui(chrome, `ui.select('文体').value`)) === 'polite');
  await ui(chrome, `ui.choose('文体', '')`);
  await click(chrome, '翻訳元と翻訳先を入れ替える');
  await ui(chrome, `ui.choose('翻訳元', '')`);
  check('翻訳元が自動なら入れ替えられない', await ui(chrome, `ui.button('翻訳元と翻訳先を入れ替える').disabled`));
  await ui(chrome, `ui.choose('翻訳元', 'en')`);
  await ui(chrome, `ui.choose('翻訳先', 'ja')`);

  // 予約された文字列。
  await setSource(chrome, 'abc <|plamo:tag|> def');
  await click(chrome, '翻訳する');
  await waitUi(chrome, `ui.outputPane().querySelector('[role=alert]')`, 5000);
  check('予約された文字列を案内する', (await ui(chrome, `ui.outputPane().innerText`)).includes('使用できない文字列'));

  // 生成中の停止。
  await setSource(chrome, longInput.text);
  check('短い原文では止められない旨を案内しない', !(await ui(chrome, 'ui.text()')).includes('途中で止められません'));
  await setSource(chrome, longInput.text.repeat(2));
  check('長い原文では止められないことを案内する', (await ui(chrome, 'ui.text()')).includes('途中で止められません'));
  await setSource(chrome, longInput.text);
  await click(chrome, '翻訳する');
  await waitUi(chrome, `ui.output().length > 20`, 60000);
  await chrome.screenshot(resolve(ROOT, '.verify', 'screens', 'real-generating.png'));
  // 生成中も、訳文の上限 (コンテキスト長 − 原文のトークン数) が数値で出る。
  const generatingDecode = await metricsOf(chrome, '訳文の生成');
  const generatingPrefill = Number((await metricsOf(chrome, '原文の処理')).match(/^([\d,]+) tokens/)?.[1].replaceAll(',', ''));
  const generatingLimit = Number(generatingDecode.match(/^[\d,]+ \/ ([\d,]+) tokens/)?.[1].replaceAll(',', ''));
  check('生成中も訳文の欄に上限を数値で表示する', generatingLimit > 0 && generatingLimit + generatingPrefill === 8192, {
    decode: generatingDecode.split('\n')[0],
    prefill: generatingPrefill,
  });
  check('翻訳中はボタンが「停止する」に切り替わる', await ui(chrome, `Boolean(ui.button('停止する')) && !ui.button('翻訳する')`));
  await click(chrome, '停止する');
  await waitUi(chrome, `ui.outputPane().innerText.includes('停止しました')`, 10000);
  check('生成中に停止すると訳文が残る', (await ui(chrome, 'ui.output().length')) > 20);

  // 原文の処理中の停止。
  await setSource(chrome, farX2.text);
  await setContext(chrome, farX2.context);
  await click(chrome, '翻訳する');
  await waitUi(chrome, `ui.outputPane().innerText.includes('原文を処理しています')`, 5000);
  check('原文の処理中はその旨と経過時間を表示する', (await ui(chrome, `ui.outputPane().innerText`)).includes('経過'));
  // トークン数は自前のトークナイザーで数えるので、最初の出力を待たずに出る。
  await waitUi(chrome, `document.querySelector('[role=group][aria-label="原文の処理"]')`, 5000);
  const processingMetrics = await metricsOf(chrome, '原文の処理');
  // 値は翻訳先や文体の選択で少し変わるので、参照データ (far_x2 は 6,328) に近いことだけを見る。
  const processingTokens = Number(processingMetrics.match(/^([\d,]+) tokens$/)?.[1].replaceAll(',', ''));
  check('原文の処理中から、原文の欄にトークン数を表示する', processingTokens >= 6000, {shown: processingMetrics});
  await sleep(1500);
  await click(chrome, '停止する');
  await waitUi(chrome, `ui.button('停止中')`, 3000);
  const stoppingText = await ui(chrome, `ui.outputPane().innerText`);
  check('停止を押すと停止中になり理由を表示する', stoppingText.includes('原文の処理が終わると停止します'));
  check('停止中は翻訳できない', await ui(chrome, `ui.button('停止中').disabled && !ui.button('翻訳する')`));
  check('停止中はモデルを操作できない', await ui(chrome, `ui.select('モデル').disabled && ui.select('コンテキスト長').disabled && ui.button('このブラウザから削除').disabled`));
  await chrome.screenshot(resolve(ROOT, '.verify', 'screens', 'real-stopping.png'));
  await waitUi(chrome, `ui.outputPane().innerText.includes('停止しました')`, 120000);
  check('処理が終わると訳文なしで止まる', (await ui(chrome, 'ui.output()')) === '');

  // コンテキスト長の変更と入力超過。
  await ui(chrome, `ui.choose('コンテキスト長', '2048')`);
  await waitUi(chrome, `ui.button('読み込む')`, 3000);
  check('設定を変えると読み込み直しを案内する', (await ui(chrome, 'ui.text()')).includes('まだ読み込んでいません'));
  await click(chrome, '読み込む');
  await waitUi(chrome, `!ui.button('読み込む') && ui.text().includes('準備完了')`, 120000);
  await click(chrome, '翻訳する');
  await waitUi(chrome, `ui.outputPane().querySelector('[role=alert]')`, 15000);
  const overflow = await ui(chrome, `ui.outputPane().innerText`);
  check('入力超過はトークン数と上限を案内する', overflow.includes('6,328') && overflow.includes('2,048'), overflow.slice(0, 80));
  // 参考文脈もコンテキスト長を使うので、使ったときは短くできるものとして名指しする。
  check(
    '参考文脈を使った入力超過は、参考文脈も名指しする',
    overflow.includes('原文と参考文脈の合計が長すぎます') && overflow.includes('参考文脈を短くするか'),
    overflow.slice(0, 120),
  );
  await chrome.screenshot(resolve(ROOT, '.verify', 'screens', 'real-too-long.png'));

  // 上限への到達。
  await setContext(chrome, '');
  await setSource(chrome, longInput.text);
  await ui(chrome, `ui.choose('文体', 'polite')`);
  await click(chrome, '翻訳する');
  await waitUi(chrome, `ui.outputPane().innerText.includes('途中で切れています')`, 120000);
  // 原文の処理と訳文の生成のトークン数の和が、ちょうど上限になっている。
  const prefillAtLimit = Number((await metricsOf(chrome, '原文の処理')).match(/^([\d,]+) tokens/)?.[1].replaceAll(',', ''));
  const decodeAtLimit = (await metricsOf(chrome, '訳文の生成')).match(/^([\d,]+) \/ ([\d,]+) tokens/);
  const toNumber = value => Number(value?.replaceAll(',', ''));
  check(
    '上限に達すると切れたことを表示する (訳文のトークン数が上限と同じ)',
    decodeAtLimit !== null &&
      prefillAtLimit + toNumber(decodeAtLimit[1]) === 2048 &&
      toNumber(decodeAtLimit[2]) === 2048 - prefillAtLimit,
    {prefill: prefillAtLimit, decode: decodeAtLimit?.[0]},
  );
  const truncatedNotice = await ui(chrome, `ui.outputPane().querySelector('[role=alert]').innerText`);
  check(
    '参考文脈を使っていない上限到達は、原文の分割だけを案内する',
    truncatedNotice.includes('原文を分割するか、より大きいコンテキスト長') && !truncatedNotice.includes('参考文脈'),
    truncatedNotice,
  );
  await ui(chrome, `ui.choose('文体', '')`);

  // キーボード。
  await setSource(chrome, shortRef[0].text);
  await ui(chrome, `ui.choose('翻訳元', ${JSON.stringify(shortRef[0].source_lang)})`);
  await ui(chrome, `ui.choose('翻訳先', ${JSON.stringify(shortRef[0].target_lang)})`);
  await chrome.evaluate(`window.__ui.source().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true}))`);
  await waitUi(chrome, `ui.output() === ${JSON.stringify(shortRef[0].output)}`, 30000);
  check('Ctrl+Enter で翻訳できる', true);

  // テーマ。
  const background = () => chrome.evaluate(`getComputedStyle(document.documentElement).backgroundColor`);
  const before = await background();
  const firstLabel = await ui(chrome, `ui.button('ダークテーマに切り替える') ? 'ダークテーマに切り替える' : 'ライトテーマに切り替える'`);
  await click(chrome, firstLabel);
  const other = firstLabel === 'ダークテーマに切り替える' ? 'ライトテーマに切り替える' : 'ダークテーマに切り替える';
  check('テーマを切り替えるとボタンと背景が変わる', (await ui(chrome, `Boolean(ui.button(${JSON.stringify(other)}))`)) && (await background()) !== before);
  if (firstLabel === 'ダークテーマに切り替える') await click(chrome, other);
  await ui(chrome, `ui.button('ライトテーマに切り替える') && ui.click('ライトテーマに切り替える')`);
  await idleAfterTranslate(chrome);
  const themeIcon = () => chrome.evaluate(`document.querySelector('button[aria-label$="テーマに切り替える"] path').getAttribute('d')`);
  const lightIcon = await themeIcon();
  await click(chrome, 'ダークテーマに切り替える');
  check('テーマのアイコンはライトが月、ダークが太陽', lightIcon.startsWith('M21 12.79') && (await themeIcon()).startsWith('M12 4V2'));
  await sleep(500); // 色の遷移が終わるのを待つ。
  const darkColors = await chrome.evaluate(`(() => {
    const canvas = document.createElement('canvas').getContext('2d');
    const hex = value => { canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1); const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data; return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''); };
    const root = getComputedStyle(document.documentElement);
    // 訳文の欄は背景を持たない。原文と訳文を載せた 1 枚の紙 (見開き) の色を見る。
    const sheet = window.__ui.outputPane().closest('.bg-base-100');
    return {page: hex(root.backgroundColor), panel: hex(getComputedStyle(sheet).backgroundColor), accent: hex(getComputedStyle(window.__ui.button('翻訳する')).backgroundColor)};
  })()`);
  check('ダークの色が指定どおり', darkColors.page === '#201b18' && darkColors.panel === '#2d2623' && darkColors.accent === '#bf9a7e', darkColors);

  // 詳細オプションの記憶。参考文脈、用語集、欄の開閉は、再読み込みしても残る (原文は残らない)。
  const savedContext = '設定の記憶を確かめるための参考文脈';
  await setContext(chrome, savedContext);
  await click(chrome, '用語を追加');
  await chrome.evaluate(`(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const [source, target] = document.querySelectorAll('details input');
    for (const [input, value] of [[source, 'restart'], [target, '再起動']]) {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', {bubbles: true}));
    }
  })()`);

  // 再読み込み。ページを開いた時点ではモデルを読み込まず、翻訳を始めると読み込む。
  await open(chrome);
  check('再読み込みしてもテーマが保たれる', (await chrome.evaluate(`document.documentElement.dataset.theme`)) === 'ink');
  const advanced = await chrome.evaluate(`(() => {
    const details = document.querySelector('details');
    return {open: details.open, context: details.querySelector('textarea').value, glossary: [...details.querySelectorAll('input')].map(input => input.value)};
  })()`);
  check(
    '再読み込みしても参考文脈、用語集、詳細オプションの開閉が残る',
    advanced.open && advanced.context === savedContext && advanced.glossary.join('|') === 'restart|再起動',
    advanced,
  );
  check('再読み込みすると原文は空に戻る', (await ui(chrome, 'ui.source().value')) === '');
  // この後の翻訳を参照と比べるので、空に戻して閉じる。
  await setContext(chrome, '');
  await click(chrome, '用語 1 を削除');
  await chrome.evaluate(`document.querySelector('details').open = false`);
  await waitUi(chrome, `!ui.text().includes('確認しています')`, 60000);
  check('再訪問時はモデルを読み込まない', await ui(chrome, `ui.text().includes('未ロード') && ui.text().includes('翻訳を始めると、読み込んでから翻訳します')`));
  await ui(chrome, `ui.choose('翻訳元', ${JSON.stringify(shortRef[0].source_lang)})`);
  await ui(chrome, `ui.choose('翻訳先', ${JSON.stringify(shortRef[0].target_lang)})`);
  await setSource(chrome, shortRef[0].text);
  await click(chrome, '翻訳する');
  check(
    '翻訳を始めると、読み込み中の表示を出してから読み込む',
    await ui(chrome, `Boolean(ui.button('読み込み中')) && ui.outputPane().innerText.includes('モデルを読み込んでいます')`),
  );
  await ready(chrome);
  await idleAfterTranslate(chrome);
  check('読み込んでから翻訳した訳文が参照と一致する', (await ui(chrome, 'ui.output()')) === shortRef[0].output);
  await chrome.screenshot(resolve(ROOT, '.verify', 'screens', 'real-dark-revisit.png'));

  // スマートフォン幅。
  await chrome.setViewport(375, 812, true);
  await sleep(300);
  check('375 px 幅で横にはみ出さない', (await chrome.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)) === true);
  check('スマートフォン幅ではモデルの設定を閉じている', await ui(chrome, `ui.select('モデル').offsetParent === null`));
  await click(chrome, '設定を変更');
  await sleep(100);
  check('開くとモデルの設定を操作できる', await ui(chrome, `ui.select('モデル').offsetParent !== null`));
  const contextLabel = await ui(chrome, `(() => {
    const label = ui.select('コンテキスト長').closest('label');
    const note = label.querySelector('.whitespace-nowrap').getBoundingClientRect();
    const box = label.getBoundingClientRect();
    // label には選択肢の文字も入るので、見出しの span だけを読む。
    return {text: note.width > 0 ? label.querySelector('span').textContent.trim() : '', noteLeft: Math.round(note.left), labelLeft: Math.round(box.left), noteRight: Math.round(note.right), labelRight: Math.round(box.right)};
  })()`);
  check(
    'スマートフォン幅では、コンテキスト長の見出しを括弧の前で改行し、はみ出さない',
    contextLabel.text === 'コンテキスト長 (原文・参考文脈・用語集・訳文の合計の上限)' &&
      contextLabel.noteLeft === contextLabel.labelLeft &&
      contextLabel.noteRight <= contextLabel.labelRight,
    contextLabel,
  );
  await chrome.setViewport(1536, 1024);

  // 実際の GPU のエラー。
  await chrome.evaluateInWorker(`self.plamoDevice.destroy()`);
  await waitUi(chrome, `ui.text().includes('GPU が使えなくなりました')`, 10000);
  check('GPU が失われると案内が出る (実際の device.lost)', await ui(chrome, `Boolean(ui.button('やり直す'))`));
  await click(chrome, 'やり直す');
  await waitUi(chrome, `ui.button('読み込む')`, 5000);
  await click(chrome, '読み込む');
  await ready(chrome);
  await setSource(chrome, shortRef[0].text);
  await click(chrome, '翻訳する');
  await waitUi(chrome, `ui.output() === ${JSON.stringify(shortRef[0].output)}`, 30000);
  check('やり直すと新しい GPU デバイスで翻訳できる', true);

  await idleAfterTranslate(chrome);
  // GPU のエラーは GPU の処理が動くまで届かないので、エラーの後に翻訳する。
  await chrome.evaluateInWorker(`self.plamoDevice.createBuffer({size: 4, usage: 0}); true`);
  await click(chrome, '翻訳する');
  await waitUi(chrome, `ui.text().includes('GPU でエラーが起きました')`, 30000);
  check('GPU のエラーで案内が出る (実際の uncapturederror)', await ui(chrome, `Boolean(ui.button('やり直す'))`));
  await click(chrome, 'やり直す');
  await waitUi(chrome, `ui.button('読み込む')`, 5000);
  await click(chrome, '読み込む');
  await ready(chrome);
  check('GPU のエラーの後もやり直して読み込める', true);

  // 削除。設定の欄を開いてから押す。
  if (!(await ui(chrome, `ui.button('このブラウザから削除').offsetParent !== null`))) await click(chrome, '設定を変更');
  await click(chrome, 'このブラウザから削除');
  await waitUi(chrome, `ui.button('ダウンロードして読み込む')`, 15000);
  check('削除すると未ダウンロードに戻る', (await ui(chrome, 'ui.text()')).includes('未ダウンロード'));

  // CSP。
  const csp = await chrome.evaluate(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ''`);
  check('本番ビルドに CSP がある', csp.includes("connect-src 'self' https://huggingface.co https://*.hf.co"));
  const blocked = await chrome.evaluate(`fetch('https://example.com/', {mode: 'no-cors'}).then(() => 'allowed', () => 'blocked')`);
  check('主スレッドから許可していない宛先に通信できない', blocked === 'blocked', blocked);
  const allowed = await chrome.evaluate(`fetch('https://huggingface.co/api/models?limit=1').then(r => r.ok ? 'allowed' : 'status ' + r.status, e => 'blocked: ' + e.message)`);
  check('主スレッドから Hugging Face には通信できる', allowed === 'allowed', allowed);

  // CSP が Worker に効くかの実測。結果を記録するだけで、合否には使わない。
  await chrome.evaluate(`void window.plamoTranslator.load(); null`).catch(() => {});
  await sleep(300);
  const workerResult = await chrome.evaluateInWorker(`fetch('https://example.com/', {mode: 'no-cors'}).then(() => 'allowed', () => 'blocked')`).catch(error => `error: ${error.message}`);
  console.log(`INFO  Worker から許可していない宛先への通信: ${workerResult}`);
  results.push({name: 'info: worker csp', ok: true, detail: workerResult});
  await chrome.evaluate(`window.plamoTranslator.cancelDownload()`);

  // プライバシー。
  const probes = [item.text, item.output, shortRef[0].text, shortRef[0].output, farX2.text.slice(0, 60)];
  const storage = await chrome.evaluate(`JSON.stringify(Object.assign({}, localStorage))`);
  check('localStorage に原文と訳文が残らない', !probes.some(value => storage.includes(value)));
  const consoleText = chrome.observed.console.map(entry => entry.text).join('\n');
  writeFileSync(resolve(ROOT, '.verify', 'console-ui.txt'), consoleText);
  check('コンソールに原文と訳文が残らない', !probes.some(value => consoleText.includes(value)));
  const external = chrome.observed.requests.filter(url => /^https?:/.test(url) && !['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
  const unexpected = external.filter(url => !url.startsWith('https://huggingface.co/api/models') && !url.startsWith('https://example.com'));
  check('操作の間に外部への通信がない (上の確認を除く)', unexpected.length === 0, unexpected.slice(0, 5));
  check('未処理の例外がない', chrome.observed.exceptions.length === 0, chrome.observed.exceptions.slice(0, 3));
}

/** WebGPU を使えないブラウザでの案内を確かめる。 */
async function withoutWebGpu(label, args, expected, options) {
  const browser = await openChrome(`verify-${label}`, args, options);
  try {
    await browser.navigate(PAGE);
    await browser.evaluate(HELPERS);
    await waitUi(browser, `!ui.text().includes('確認しています')`, 60000);
    const shown = await ui(browser, 'ui.text()');
    await browser.screenshot(resolve(ROOT, '.verify', 'screens', `real-${label}.png`));
    const match = expected.find(text => shown.includes(text));
    check(`${label}: 理由と取れる行動を表示する`, Boolean(match), {shown: match ?? shown.slice(0, 200)});
    check(`${label}: ロードの操作ができない`, await ui(browser, `!ui.button('ダウンロードして読み込む') && !ui.button('読み込む') && ui.select('モデル').disabled`));
    check(`${label}: 翻訳できない`, await ui(browser, `ui.button('翻訳する').disabled`));
    check(`${label}: 未処理の例外がない`, browser.observed.exceptions.length === 0, browser.observed.exceptions.slice(0, 2));
  } finally {
    await browser.close();
  }
}

mkdirSync(resolve(ROOT, '.verify', 'screens'), {recursive: true});
const build = startProcess('bun run build --mode verify --outDir .verify/dist --emptyOutDir');
if ((await build.exited) !== 0) throw new Error(build.lines.join('\n'));
const server = startProcess('bun run preview --mode verify --outDir .verify/dist --port 5198 --strictPort --host 127.0.0.1');
const chrome = await openChrome('verify-ui');
try {
  await waitForHttp(PAGE);
  await run(chrome);
  await chrome.close();
  // Chrome の起動オプションでは navigator.gpu を消せないので、環境を確認する Worker の起動時に消す。
  await withoutWebGpu('no-webgpu-api', [], ['このブラウザは WebGPU に対応していません'], {workerInit: 'delete WorkerNavigator.prototype.gpu'});
  await withoutWebGpu('no-gpu', ['--disable-gpu', '--disable-software-rasterizer'], [
    'WebGPU を使える GPU が見つかりません',
    'ハードウェアの GPU を使えません',
    'このブラウザは WebGPU に対応していません',
  ]);
} catch (error) {
  check('実行エラー', false, String(error.stack ?? error).slice(0, 1200));
  await chrome.screenshot(resolve(ROOT, '.verify', 'screens', 'real-failure.png')).catch(() => {});
} finally {
  await chrome.close();
  server.stop();
}

writeFileSync(resolve(ROOT, '.verify', 'result-ui.json'), JSON.stringify(results, null, 2));
const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
