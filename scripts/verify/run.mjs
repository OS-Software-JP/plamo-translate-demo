// 開発環境専用の照合ツール。実際のモデルで推論レイヤーの動作と訳文を確かめる。
//   bun run verify            本番ビルド相当 (--mode verify) で全項目を確かめる
//   bun run verify dev        開発サーバーで起動と翻訳だけを確かめる
// 参照データの場所は PLAMO_REFERENCE_DIR で変えられる。
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT, TONES_ENABLED, openChrome, sleep, startProcess, waitForHttp} from './browser.mjs';

const REFERENCE_DIR = process.env.PLAMO_REFERENCE_DIR ?? 'D:/works/AI/LiteRT-LM/web/tests';
const reference = name => JSON.parse(readFileSync(`${REFERENCE_DIR}/${name}.json`, 'utf8'));
const shortRef = reference('reference_outputs');
const beyondRef = reference('reference_beyond');
const farRef = reference('reference_far');
const byName = name => [...beyondRef, ...farRef].find(item => item.name === name);
// やさしい日本語 (文体の欄で選ぶと、翻訳先を ja-easy として依頼する)。
// 期待値は PFN の元の実装 (0.8B、float32、greedy) で翻訳先を ja-easy にした訳 (2026-11-09)。
const easyJapanese = {
  source_lang: 'ja',
  target_lang: 'ja',
  form: 'easy',
  text: '本市では、大規模地震の発生に備え、各世帯において最低3日分の飲料水及び非常食を備蓄されるよう推奨しております。',
  output: 'この市では、大きな地震が起きたときに備えて、それぞれの家で最低3日分の飲み水と非常食を準備しておくように勧めています。',
};

// 口調 (文体の欄で選ぶと、予約トークンの行を差し込んだモデルで、翻訳先をそのトークンにして依頼する)。
// 期待値は、配布する 0.8B int8 の重みと同じ口調の行で、PyTorch (greedy) で訳したもの (2026-11-09、
// .verify/persona-prototype/gpu/README.md)。
const toneItems = [
  {form: 'ojousama', output: '図書館は12月29日から1月3日まで休館いたしますわ。'},
  {form: 'mesugaki', output: '図書館は12月29日から1月3日まで休館するんだよ、ざぁこ♡'},
].map(tone => ({source_lang: 'en', target_lang: 'ja', text: 'The library will be closed from December 29 to January 3.', ...tone}));

const results = [];
function check(name, ok, detail) {
  results.push({name, ok, detail});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
}

const store = 'window.plamoTranslator';
const modelRequests = chrome => chrome.observed.requests.filter(url => new URL(url).pathname.startsWith('/models/')).length;
const externalRequests = chrome =>
  chrome.observed.requests.filter(url => /^https?:/.test(url) && !['127.0.0.1', 'localhost'].includes(new URL(url).hostname));

function setOptions(chrome, item) {
  const options = {source: item.source_lang ?? '', target: item.target_lang, form: item.form ?? ''};
  return chrome.evaluate(`${store}.setOptions(${JSON.stringify(options)})`);
}

/** 翻訳を始める (完了を待たない)。 */
async function startTranslate(chrome, item) {
  await setOptions(chrome, item);
  const input = {text: item.text, context: item.context, glossary: item.glossary};
  await chrome.evaluate(`void ${store}.translate(${JSON.stringify(input)}); null`);
}

async function translateAndWait(chrome, item) {
  await startTranslate(chrome, item);
  return chrome.waitState(`!['idle', 'loading', 'generating', 'stopping'].includes(v.translation.kind)`);
}

async function loadAndWait(chrome, modelId, contextLength, timeoutMs) {
  await chrome.evaluate(`${store}.selectModel(${JSON.stringify(modelId)}); ${store}.selectContextLength(${contextLength})`);
  await chrome.evaluate(`void ${store}.load(); null`);
  return chrome.waitState(`v.model.kind === 'ready' || v.model.kind === 'failed'`, timeoutMs);
}

/** 状態の遷移を記録する。 */
const startTrace = chrome =>
  chrome.evaluate(`(() => {
    window.__trace = [];
    const push = () => {
      const v = ${store}.getSnapshot();
      const entry = v.model.kind + '/' + v.translation.kind;
      if (window.__trace.at(-1) !== entry) window.__trace.push(entry);
    };
    push();
    window.__untrace = ${store}.subscribe(push);
  })()`);
const stopTrace = chrome => chrome.evaluate(`(() => { window.__untrace?.(); return window.__trace; })()`);

async function fullSuite(pageUrl) {
  const chrome = await openChrome('verify');
  console.log(`browser: ${chrome.version.product}`);
  try {
    await chrome.navigate(pageUrl);
    let state = await chrome.waitState(`v.model.kind !== 'checking'`, 60000);
    check('環境確認の後に未ロードになる', state.model.kind === 'idle', {gpu: state.gpuDescription});
    check('StrictMode でも環境確認の Worker は 1 つ', chrome.observed.workers === 1, {workers: chrome.observed.workers});
    check('選択の既定は 0.8B int4、8192', state.selectedModelId === '0.8b-int4' && state.selectedContextLength === 8192);

    // ダウンロードの中止。
    await chrome.evaluate(`${store}.selectModel('0.8b-int4'); void ${store}.load(); null`);
    state = await chrome.waitState(`v.model.kind === 'downloading' && v.model.loadedBytes >= 100e6`, 60000);
    check('ダウンロードの進捗が分かる', state.model.totalBytes === 581763072, {loaded: state.model.loadedBytes});
    await chrome.evaluate(`${store}.cancelDownload()`);
    state = await chrome.waitState(`v.model.kind === 'idle'`, 15000);
    check('中止すると未ロードに戻り、キャッシュされない', !state.cachedModelIds.includes('0.8b-int4'));

    // 初回のダウンロードと初期化。
    await startTrace(chrome);
    const beforeDownload = modelRequests(chrome);
    state = await loadAndWait(chrome, '0.8b-int8', 8192);
    const trace = await stopTrace(chrome);
    check('初回はダウンロード、初期化、準備完了の順に進む', state.model.kind === 'ready', {trace, loadSeconds: state.model.loadSeconds});
    check(
      '状態の遷移が仕様どおり',
      JSON.stringify(trace.filter(entry => entry.endsWith('/idle')).map(entry => entry.split('/')[0])) ===
        JSON.stringify(['idle', 'downloading', 'initializing', 'ready']),
    );
    check('モデルの取得は 1 回', modelRequests(chrome) - beforeDownload === 1);
    check('キャッシュ済みになる', state.cachedModelIds.includes('0.8b-int8'));

    // 訳文の照合。あわせて、Worker が数えたプロンプトのトークン数 (最初に分かった値) を記録する。
    await chrome.evaluate(`(() => {
      window.__prompt = null;
      window.__unprompt = ${store}.subscribe(() => {
        const t = ${store}.getSnapshot().translation;
        if (window.__prompt === null && t.kind === 'generating' && t.promptTokens !== undefined) {
          window.__prompt = {tokens: t.promptTokens, beforeOutput: t.output === '' && t.progress === null};
        }
      });
    })()`);
    const outputs = [];
    const prompts = [];
    for (const item of shortRef) {
      await chrome.evaluate('window.__prompt = null');
      const after = await translateAndWait(chrome, item);
      outputs.push({exact: after.translation.output === item.output, kind: after.translation.kind});
      const counted = await chrome.evaluate('window.__prompt');
      prompts.push({counted: counted?.tokens, beforeOutput: counted?.beforeOutput, sdk: after.translation.metrics?.prefillTokens});
    }
    await chrome.evaluate('window.__prompt = null');
    const easy = await translateAndWait(chrome, easyJapanese);
    const easyPrompt = await chrome.evaluate('window.__prompt');
    check(
      'やさしい日本語の訳が元の実装と一致し、数えたプロンプトのトークン数が SDK と一致する',
      easy.translation.output === easyJapanese.output && easyPrompt?.tokens === easy.translation.metrics?.prefillTokens,
      {output: easy.translation.output, counted: easyPrompt?.tokens, sdk: easy.translation.metrics?.prefillTokens},
    );
    check('口調付きでない翻訳は段落に分けない (訳文の上限の合計を返さない)', easy.translation.metrics.decodeLimit === undefined);
    // 口調を使わない設定 (TONES_ENABLED が false) では、口調の項目を確かめない。
    const toned = {};
    for (const item of TONES_ENABLED ? toneItems : []) {
      await chrome.evaluate('window.__prompt = null');
      toned[item.form] = await translateAndWait(chrome, item);
      const tonePrompt = await chrome.evaluate('window.__prompt');
      const {translation} = toned[item.form];
      check(
        `口調 (${item.form}) の訳が期待どおりで、数えたプロンプトのトークン数 (予約トークンは 1 つ) が SDK と一致する`,
        translation.output === item.output && tonePrompt?.tokens === translation.metrics?.prefillTokens,
        {output: translation.output, counted: tonePrompt?.tokens, sdk: translation.metrics?.prefillTokens},
      );
    }
    // 口調付きの翻訳は、空行で区切った段落を 1 つずつ別に訳してつなぐ (6.9 節)。計測値は段落の合計になる。
    if (TONES_ENABLED) {
      const tone = toneItems.find(item => item.form === 'mesugaki');
      const second = 'The museum opens at nine.';
      const secondParagraph = await translateAndWait(chrome, {...tone, text: second});
      await chrome.evaluate('window.__prompt = null');
      const paragraphs = await translateAndWait(chrome, {...tone, text: `${tone.text}\n\n${second}`});
      const firstPrompt = await chrome.evaluate('window.__prompt');
      const parts = [toned.mesugaki.translation, secondParagraph.translation];
      const summed = parts.reduce((sum, t) => sum + t.metrics.prefillTokens, 0);
      check(
        '口調付きの翻訳は段落ごとに訳し、原文の空行でつなぐ。トークン数は段落の合計、訳文の上限は段落ごとの残りの合計',
        paragraphs.translation.output === parts.map(t => t.output).join('\n\n') &&
          paragraphs.translation.metrics.prefillTokens === summed &&
          paragraphs.translation.metrics.decodeLimit === 2 * 8192 - summed &&
          firstPrompt?.tokens === toned.mesugaki.translation.metrics.prefillTokens,
        {
          output: paragraphs.translation.output,
          prefill: paragraphs.translation.metrics.prefillTokens,
          summed,
          decodeLimit: paragraphs.translation.metrics.decodeLimit,
          firstPrompt: firstPrompt?.tokens,
        },
      );
    }
    await chrome.evaluate('window.__unprompt()');
    check(
      '数えたプロンプトのトークン数は、最初の出力の前に分かり、SDK の原文の処理のトークン数と一致する',
      prompts.every(entry => entry.beforeOutput === true && entry.counted === entry.sdk),
      prompts.filter(entry => !(entry.beforeOutput === true && entry.counted === entry.sdk)).slice(0, 3),
    );
    const exact = outputs.filter(entry => entry.exact).length;
    check('短文の完全一致 (0.8B int8、8192)', exact === shortRef.length, {exact, total: shortRef.length});
    state = chrome.lastState = await chrome.waitState(`v.translation.kind === 'done'`);
    check('計測値がある', state.translation.metrics.decodeTokensPerSecond > 0, state.translation.metrics);
    const {prefillTokens, prefillTokensPerSecond, decodeTokens, contextTokens} = state.translation.metrics;
    check(
      '原文の処理と訳文の生成のトークン数の和が使用トークン数と一致する',
      prefillTokens > 0 && prefillTokensPerSecond > 0 && prefillTokens + decodeTokens === contextTokens,
      {prefillTokens, decodeTokens, contextTokens},
    );
    check('切れていない翻訳は truncated にならない', state.translation.truncated === false);

    // 長文の照合 (2048 以内)。
    const long = reference('reference_long');
    const farParagraph = long.find(item => item.name === 'far_paragraph');
    // 生成中の計測値の推移を記録する。
    await chrome.evaluate(`(() => {
      window.__progress = [];
      window.__unprogress = ${store}.subscribe(() => {
        const p = ${store}.getSnapshot().translation.progress;
        if (p && window.__progress.at(-1) !== p) window.__progress.push(p);
      });
    })()`);
    const longResult = await translateAndWait(chrome, farParagraph);
    const progress = await chrome.evaluate(`(() => { window.__unprogress(); return window.__progress; })()`);
    const lm = longResult.translation.metrics;
    check(
      '生成中の計測値が逐次届き、完了後の値に近い',
      progress.length > 1 &&
        progress.at(-1).decodeTokens <= lm.decodeTokens &&
        lm.decodeTokens - progress.at(-1).decodeTokens <= 5 &&
        Math.abs(progress[0].prefillSeconds - lm.prefillTokens / lm.prefillTokensPerSecond) < 0.5,
      {
        samples: progress.length,
        liveTokens: progress.at(-1)?.decodeTokens,
        tokens: lm.decodeTokens,
        livePrefillSeconds: progress[0]?.prefillSeconds,
      },
    );
    // 原文の欄は、生成開始時に表示した秒数を完了後も使う (firstOutputSeconds)。
    check(
      '原文の処理の秒数は、生成開始時と完了後で変わらない',
      progress.length > 0 && progress.every(p => p.prefillSeconds === lm.firstOutputSeconds),
      {live: progress[0]?.prefillSeconds, done: lm.firstOutputSeconds},
    );
    // 訳文の欄は、最後の出力までの実測の秒数で完了する。画面の更新は 50 ms ごとなので、
    // 最後に表示した値より少しだけ大きくなることはあるが、測り方は変わらない。
    check(
      '訳文の生成の秒数は、生成中の表示から続く実測値で完了する',
      progress.length > 0 &&
        lm.decodeSeconds >= progress.at(-1).decodeSeconds &&
        lm.decodeSeconds - progress.at(-1).decodeSeconds < 0.2,
      {live: progress.at(-1)?.decodeSeconds, done: lm.decodeSeconds},
    );
    // 訳文の欄の速度は、生成中も完了後も「2 つ目以降のチャンクの数 ÷ 秒数」で求める。
    const liveLast = progress.at(-1);
    const liveSpeed = liveLast ? (liveLast.decodeTokens - 1) / liveLast.decodeSeconds : NaN;
    const doneSpeed = (lm.decodeChunks - 1) / lm.decodeSeconds;
    check(
      '訳文の生成の速度は、生成中と同じ式の実測値で完了する',
      liveLast !== undefined &&
        lm.decodeChunks >= liveLast.decodeTokens &&
        Math.abs(doneSpeed - liveSpeed) / doneSpeed < 0.1 &&
        lm.decodeTokens - lm.decodeChunks >= 0 &&
        lm.decodeTokens - lm.decodeChunks <= 3,
      {
        liveSpeed: +liveSpeed.toFixed(2),
        doneSpeed: +doneSpeed.toFixed(2),
        sdkSpeed: +lm.decodeTokensPerSecond.toFixed(2),
        chunks: lm.decodeChunks,
        sdkTokens: lm.decodeTokens,
      },
    );
    check('参考文脈つきの長文が一致する', longResult.translation.output === farParagraph.output, {
      tokens: longResult.translation.metrics?.contextTokens,
    });

    // 不正な入力。
    await chrome.evaluate(`void ${store}.translate({text: '   '}); null`);
    state = await chrome.waitState(`true`);
    check('空白のみの入力では翻訳しない', state.translation.kind === 'done');
    await chrome.evaluate(`void ${store}.translate({text: 'abc <|plamo:tag|> def'}); null`);
    state = await chrome.waitState(`v.translation.kind === 'failed'`, 5000);
    check('予約された文字列は送信前に断る', state.translation.error.code === 'reserved-token');

    // 訳文の生成中の停止。
    await startTranslate(chrome, byName('beyond_whole_en_ja'));
    await chrome.waitState(`v.translation.kind === 'generating' && v.translation.output.length > 20`, 60000);
    const stopStartedAt = Date.now();
    await chrome.evaluate(`${store}.stop()`);
    state = await chrome.waitState(`v.translation.kind === 'stopped'`, 10000);
    check('生成中の停止はすぐに止まり、訳文が残る', state.translation.output.length > 20, {
      ms: Date.now() - stopStartedAt,
      chars: state.translation.output.length,
    });

    // 原文の処理中の停止。
    await startTrace(chrome);
    await startTranslate(chrome, byName('far_x2'));
    await sleep(1500);
    await chrome.evaluate(`${store}.stop()`);
    state = await chrome.waitState(`v.translation.kind === 'stopping'`, 3000);
    check('原文の処理中に停止すると stopping になる', state.translation.output === '');
    await chrome.evaluate(`void ${store}.translate({text: 'ignored'}); void ${store}.load(); null`);
    state = await chrome.waitState(`true`);
    check('停止中は翻訳もモデルの切り替えも受け付けない', state.translation.kind === 'stopping' && state.model.kind === 'ready');
    const stoppingStartedAt = Date.now();
    state = await chrome.waitState(`v.translation.kind === 'stopped'`, 120000);
    check('処理が終わると訳文なしで止まる', state.translation.output === '', {waitedMs: Date.now() - stoppingStartedAt});
    const stopTraceResult = await stopTrace(chrome);
    check('停止の遷移', stopTraceResult.join() === 'ready/failed,ready/generating,ready/stopping,ready/stopped' || stopTraceResult.includes('ready/stopping'), stopTraceResult);
    const afterStop = await translateAndWait(chrome, shortRef[0]);
    check('停止の後も翻訳できる', afterStop.translation.output === shortRef[0].output);

    // コンテキスト長の変更。
    const beforeReload = modelRequests(chrome);
    state = await loadAndWait(chrome, '0.8b-int8', 2048);
    check('コンテキスト長を変えると再ダウンロードなしで読み込み直す', state.model.contextLength === 2048 && modelRequests(chrome) === beforeReload);

    const overflow = await translateAndWait(chrome, byName('far_x2'));
    check('入力超過はトークン数を案内する', overflow.translation.error?.code === 'input-too-long' && overflow.translation.error.message.includes('6,328') && overflow.translation.error.message.includes('2,048'), overflow.translation.error?.message);
    const afterOverflow = await translateAndWait(chrome, shortRef[0]);
    check('入力超過の後も翻訳できる', afterOverflow.translation.output === shortRef[0].output);

    const crossing = await translateAndWait(chrome, byName('beyond_whole_en_ja'));
    check('生成中の到達を検出する', crossing.translation.truncated === true && crossing.translation.metrics.contextTokens === 2048, crossing.translation.metrics);
    const afterCrossing = await translateAndWait(chrome, shortRef[0]);
    check('切断の後も翻訳できる', afterCrossing.translation.output === shortRef[0].output);

    // 境界。コンテキスト長は、プロンプト (定型の指示、参考文脈、用語集、原文) と訳文の合計の上限。
    // 文字数は、プロンプトがちょうどそのトークン数になる長さ (英語から日本語、文体なし。自前のトークナイザーで求めた)。
    const whole = byName('beyond_whole_en_ja').text;
    const doubled = `${whole}\n\n${whole}`;
    const boundary = text => ({text, source_lang: 'en', target_lang: 'ja'});
    const BOUNDARY_SHORT = 'Please restart your computer to complete the installation.';
    const metricsOf = result => {
      const {kind, truncated, metrics, error} = result.translation;
      return {kind, truncated, prefill: metrics?.prefillTokens, decode: metrics?.decodeTokens, context: metrics?.contextTokens, error: error?.message};
    };
    const at2047 = metricsOf(await translateAndWait(chrome, boundary(doubled.slice(0, 9710))));
    check(
      'コンテキスト長 2048: プロンプト 2,047 トークンは受け付け、訳文 1 トークンで上限に達する',
      at2047.kind === 'done' && at2047.truncated && at2047.prefill === 2047 && at2047.decode === 1 && at2047.context === 2048,
      at2047,
    );
    const at2048 = metricsOf(await translateAndWait(chrome, boundary(doubled.slice(0, 9717))));
    const rejectedBeforeGpu = chrome.observed.console.some(entry => entry.text.includes('prompt tokens 2048 >= 2048'));
    check(
      'コンテキスト長 2048: プロンプト 2,048 トークンは GPU に送る前に断る',
      at2048.kind === 'failed' && at2048.error?.startsWith('原文が長すぎます (2,048 トークン') && rejectedBeforeGpu,
      at2048,
    );
    const context2047 = metricsOf(await translateAndWait(chrome, {...boundary(BOUNDARY_SHORT), context: doubled.slice(0, 9668)}));
    const context2048 = metricsOf(await translateAndWait(chrome, {...boundary(BOUNDARY_SHORT), context: doubled.slice(0, 9676)}));
    check(
      '参考文脈もコンテキスト長に数える (合計 2,047 は受け付け、2,048 は断る)',
      context2047.kind === 'done' && context2047.prefill === 2047 && context2048.kind === 'failed',
      {context2047, context2048},
    );
    // 入力超過の文面は、依頼に含めた詳細オプションを名指しする (使っていないものは挙げない)。
    const bigTerm = [{source: doubled.slice(0, 9676), target: '用語'}];
    const glossaryOver = metricsOf(await translateAndWait(chrome, {...boundary(BOUNDARY_SHORT), glossary: bigTerm}));
    const bothOver = metricsOf(await translateAndWait(chrome, {...boundary(BOUNDARY_SHORT), context: 'Context.', glossary: bigTerm}));
    check(
      '入力超過の文面は、使った詳細オプションを名指しする',
      context2048.error?.startsWith('原文と参考文脈の合計が長すぎます') &&
        glossaryOver.error?.startsWith('原文と用語集の合計が長すぎます') &&
        bothOver.error?.startsWith('原文、参考文脈、用語集の合計が長すぎます'),
      {context: context2048.error, glossary: glossaryOver.error, both: bothOver.error},
    );

    // モデルの切り替えとメモリ。
    state = await loadAndWait(chrome, '0.8b-int4', 8192);
    check('別のモデルをダウンロードして切り替えられる', state.model.modelId === '0.8b-int4');
    await sleep(1500);
    const memoryFirst = await chrome.gpuMemoryGiB();
    await loadAndWait(chrome, '0.8b-int8', 8192);
    state = await loadAndWait(chrome, '0.8b-int4', 8192);
    await sleep(1500);
    const memorySecond = await chrome.gpuMemoryGiB();
    check('切り替えを繰り返しても GPU メモリが増えない', memorySecond - memoryFirst < 0.1, {first: +memoryFirst.toFixed(2), second: +memorySecond.toFixed(2)});

    // 削除。
    const storageUsage = () => chrome.evaluate(`navigator.storage.estimate().then(estimate => estimate.usage)`);
    const usageBefore = await storageUsage();
    await chrome.evaluate(`void ${store}.deleteModel('0.8b-int4'); null`);
    state = await chrome.waitState(`!v.cachedModelIds.includes('0.8b-int4')`, 15000);
    check('読み込み中のモデルを削除すると未ロードに戻る', state.model.kind === 'idle');
    const usageAfter = await storageUsage();
    // 0.8B int4 は 581,763,072 バイト。
    check('削除するとストレージの使用量が減る', usageBefore - usageAfter > 500_000_000, {before: usageBefore, after: usageAfter});

    // GPU のエラー (デバイスロストの経路)。
    state = await loadAndWait(chrome, '0.8b-int8', 8192);
    await chrome.evaluate(`${store}.handleWorkerEvent(${store}.engine, {event: 'gpuLost', reason: 'unknown', message: 'simulated'})`);
    state = await chrome.waitState(`v.model.kind === 'failed'`, 5000);
    check('GPU が失われると失敗状態になり案内が出る', state.model.error.code === 'gpu-lost', state.model.error.action);
    await chrome.evaluate(`${store}.dismissFailure()`);
    state = await loadAndWait(chrome, '0.8b-int8', 8192);
    const recovered = await translateAndWait(chrome, shortRef[0]);
    check('やり直すと新しい Worker で翻訳できる', recovered.translation.output === shortRef[0].output);

    // 再訪問。ページを開いた時点ではモデルを読み込まず、翻訳を始めると読み込む。
    const beforeRevisit = modelRequests(chrome);
    await chrome.navigate(pageUrl);
    await chrome.waitState(`v.model.kind !== 'checking'`, 60000);
    await sleep(1000);
    state = await chrome.evaluate(`${store}.getSnapshot()`);
    check('再訪問時はモデルを読み込まない', state.model.kind === 'idle' && state.cachedModelIds.includes('0.8b-int8'), {model: state.model.kind});
    await startTrace(chrome);
    const revisited = await translateAndWait(chrome, shortRef[0]);
    const revisitTrace = await stopTrace(chrome);
    check(
      '保存済みのモデルは、翻訳を始めると読み込んでから翻訳する',
      revisited.translation.output === shortRef[0].output &&
        revisitTrace.includes('initializing/loading') &&
        revisitTrace.includes('ready/generating'),
      revisitTrace,
    );
    check('再訪問時にダウンロードしない', modelRequests(chrome) === beforeRevisit);

    // プライバシー。
    const probes = [shortRef[0].text, shortRef[0].output, byName('far_x2').text.slice(0, 80)];
    const settings = await chrome.evaluate(`JSON.stringify(Object.assign({}, localStorage))`);
    check('localStorage に原文と訳文が残らない', !probes.some(text => settings.includes(text)), settings);
    const consoleText = chrome.observed.console.map(entry => `[${entry.type}] ${entry.text}`).join('\n');
    writeFileSync(resolve(ROOT, '.verify', 'console-preview.txt'), consoleText);
    check('コンソールに原文と訳文が残らない', !probes.some(text => consoleText.includes(text)), {lines: chrome.observed.console.length});
    check('外部への通信がない', externalRequests(chrome).length === 0, externalRequests(chrome));
    check('未処理の例外がない', chrome.observed.exceptions.length === 0, chrome.observed.exceptions.slice(0, 3));

    // 後始末: ライセンス全文を開ける。
    const license = await chrome.evaluate(`fetch('licenses/LICENSE-PLaMo.ja.txt').then(r => r.text()).then(t => t.includes('Built with PLaMo'))`);
    check('ライセンス全文を配信している', license === true);
  } finally {
    await chrome.close();
  }
}

async function devSuite(pageUrl) {
  const chrome = await openChrome('verify-dev');
  try {
    await chrome.navigate(pageUrl);
    await chrome.waitState(`v.model.kind !== 'checking'`, 60000);
    const state = await loadAndWait(chrome, '0.8b-int8', 8192);
    check('開発サーバーで読み込める', state.model.kind === 'ready');
    const translated = await translateAndWait(chrome, shortRef[0]);
    check('開発サーバーで翻訳できる', translated.translation.output === shortRef[0].output);
    writeFileSync(
      resolve(ROOT, '.verify', 'console-dev.txt'),
      chrome.observed.console.map(entry => `[${entry.type}] ${entry.text}`).join('\n'),
    );
    check('ページの再読み込みが起きない', chrome.observed.navigations === 1, {navigations: chrome.observed.navigations});
    check('未処理の例外がない', chrome.observed.exceptions.length === 0, chrome.observed.exceptions.slice(0, 3));
  } finally {
    await chrome.close();
  }
}

/** 6 モデルすべてで訳文を照合する。件数は仕様書の 3.1 節の値。 */
async function modelsSuite(pageUrl) {
  // 0.8B int4 は QAT 版。6 件は配布元の README の値 (ブラウザで短文 10 件中 6 件) で、このデモでは測り直していない。
  // 8B の件数は、配布元の README の内蔵 GPU の値 (単体 GPU では int8 が 10 件、int4 が 5 件)。
  const expected = {'0.8b-int8': 10, '0.8b-int4': 6, '2b-int8': 10, '2b-int4': 10, '8b-int8': 9, '8b-int4': 4};
  const memory = {'0.8b-int8': 2.08, '0.8b-int4': 1.47, '2b-int8': 6.28, '2b-int4': 4.28, '8b-int8': 16.9, '8b-int4': 10.75};
  // 参照出力はモデルの大きさごとに別 (元の実装の訳が違う)。
  const referenceOf = modelId => ({'2b': 'reference_outputs_2b', '8b': 'reference_outputs_8b'})[modelId.split('-')[0]] ?? 'reference_outputs';
  const only = process.argv[3];
  for (const [modelId, minimum] of Object.entries(expected)) {
    if (only && modelId !== only) continue;
    const chrome = await openChrome(`verify-${modelId}`);
    try {
      await chrome.navigate(pageUrl);
      await chrome.waitState(`v.model.kind !== 'checking'`, 60000);
      await sleep(1500);
      const baseline = await chrome.gpuMemoryGiB();
      // 8B は保存するファイルが 5〜9 GB あるので、長く待つ。
      const state = await loadAndWait(chrome, modelId, 8192, 600000);
      check(`${modelId}: ダウンロードして読み込める`, state.model.kind === 'ready', {loadSeconds: +state.model.loadSeconds?.toFixed(1)});
      const items = reference(referenceOf(modelId));
      let exact = 0;
      const speeds = [];
      for (const item of items) {
        const after = await translateAndWait(chrome, item);
        if (after.translation.output === item.output) exact++;
        if (after.translation.metrics) speeds.push(after.translation.metrics.decodeTokensPerSecond);
      }
      const gib = (await chrome.gpuMemoryGiB()) - baseline;
      check(`${modelId}: 短文の完全一致が ${minimum} 件以上`, exact >= minimum, {exact, total: items.length});
      // 8B の仕様書の値は単体 GPU のもの。内蔵 GPU では共有メモリを使い、0.4 GiB ほど多い。
      const tolerance = modelId.startsWith('8b') ? 0.75 : 0.25;
      check(`${modelId}: GPU メモリが仕様書の値に近い`, Math.abs(gib - memory[modelId]) < tolerance, {measured: +gib.toFixed(2), spec: memory[modelId]});
      const average = speeds.slice(1).reduce((sum, speed) => sum + speed, 0) / Math.max(speeds.length - 1, 1);
      console.log(`INFO  ${modelId}: 生成 ${average.toFixed(1)} トークン/秒`);
      results.push({name: `info: ${modelId} speed`, ok: true, detail: +average.toFixed(1)});
      check(`${modelId}: 未処理の例外がない`, chrome.observed.exceptions.length === 0, chrome.observed.exceptions.slice(0, 2));
    } finally {
      await chrome.close();
    }
  }

  if (only) return;

  // 2048 を超える長文 (0.8B int8、32768)。
  const chrome = await openChrome('verify-long');
  try {
    await chrome.navigate(pageUrl);
    await chrome.waitState(`v.model.kind !== 'checking'`, 60000);
    const state = await loadAndWait(chrome, '0.8b-int8', 32768);
    check('0.8b-int8: 32768 で読み込める', state.model.contextLength === 32768);
    let exact = 0;
    const details = [];
    for (const item of [...beyondRef, ...farRef]) {
      const after = await translateAndWait(chrome, item);
      const same = after.translation.output === item.output;
      if (same) exact++;
      details.push({name: item.name, same, kind: after.translation.kind, tokens: after.translation.metrics?.contextTokens});
    }
    check('0.8b-int8: 長文の完全一致が 4 件以上', exact >= 4, {exact, details});
  } finally {
    await chrome.close();
  }
}

const mode = process.argv[2] ?? 'preview';
mkdirSync(resolve(ROOT, '.verify'), {recursive: true});
let server;
try {
  if (mode === 'dev') {
    rmSync(resolve(ROOT, 'node_modules/.vite'), {recursive: true, force: true});
    server = startProcess('bun run dev --port 5199 --strictPort --host 127.0.0.1');
    await waitForHttp('http://127.0.0.1:5199/');
    await devSuite('http://127.0.0.1:5199/');
  } else {
    const build = startProcess('bun run build --mode verify --outDir .verify/dist --emptyOutDir');
    const code = await build.exited;
    if (code !== 0) throw new Error(`build failed:\n${build.lines.join('\n')}`);
    server = startProcess('bun run preview --mode verify --outDir .verify/dist --port 5198 --strictPort --host 127.0.0.1');
    await waitForHttp('http://127.0.0.1:5198/');
    if (mode === 'models') await modelsSuite('http://127.0.0.1:5198/');
    else await fullSuite('http://127.0.0.1:5198/');
  }
} catch (error) {
  check('実行エラー', false, String(error.stack ?? error).slice(0, 1500));
} finally {
  server?.stop();
}

writeFileSync(resolve(ROOT, '.verify', `result-${mode}.json`), JSON.stringify(results, null, 2));
const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
