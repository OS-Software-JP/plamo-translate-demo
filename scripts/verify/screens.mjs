// 画面の各状態を撮影して .verify/screens/ に保存する。docs/design/ のイメージとの照合に使う。
//   bun run verify:screens
// 状態はストアを直接書き換えて作るので、モデルは読み込まない。
import {mkdirSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT, openChrome, sleep, startProcess, waitForHttp} from './browser.mjs';

const OUT = resolve(ROOT, '.verify', 'screens');
const SOURCE_TEXT = 'Machine translation has improved dramatically over the past decade thanks to neural networks.';
const LONG_TEXT = `${'The application loads a compact translation model directly in the browser and executes inference on the local device. Before generation begins, the input is divided into tokens and processed in sequence. '.repeat(6)}`;

const ready = {kind: 'ready', modelId: '0.8b-int8', contextLength: 8192, loadSeconds: 1.7};
const done = {
  kind: 'done',
  output: '機械翻訳は、ニューラルネットワークのおかげで、過去10年間で飛躍的に向上しました。',
  truncated: false,
  metrics: {
    firstOutputSeconds: 0.14,
    prefillTokens: 35,
    prefillTokensPerSecond: 307.7,
    decodeTokens: 17,
    decodeTokensPerSecond: 56.21,
    decodeSeconds: 0.3,
    decodeChunks: 16,
    contextTokens: 52,
    contextLength: 8192,
  },
};
const cached = ['0.8b-int8'];

const states = {
  ready: {model: ready, translation: done, cachedModelIds: cached, text: SOURCE_TEXT},
  'first-visit': {model: {kind: 'idle'}, translation: {kind: 'idle'}, cachedModelIds: [], text: ''},
  downloading: {
    model: {kind: 'downloading', modelId: '0.8b-int8', loadedBytes: 383e6, totalBytes: 913014784},
    translation: {kind: 'idle'},
    cachedModelIds: [],
    text: '',
  },
  initializing: {
    model: {kind: 'initializing', modelId: '0.8b-int8', contextLength: 8192},
    translation: {kind: 'idle'},
    cachedModelIds: cached,
    text: '',
  },
  processing: {model: ready, translation: {kind: 'generating', output: '', startedAt: 'T-5', progress: null, promptTokens: 254}, cachedModelIds: cached, text: LONG_TEXT},
  // ページを開いた直後。保存済みのモデルは読み込まずに待つ。
  'idle-cached': {model: {kind: 'idle'}, translation: {kind: 'idle'}, cachedModelIds: cached, text: SOURCE_TEXT},
  // 翻訳を始めたので、モデルを読み込んでいる。
  loading: {
    model: {kind: 'initializing', modelId: '0.8b-int8', contextLength: 8192},
    translation: {kind: 'loading', startedAt: 'T-2'},
    cachedModelIds: cached,
    text: SOURCE_TEXT,
  },
  // 訳文の生成中。計測値を逐次表示する。
  generating: {
    model: ready,
    translation: {
      kind: 'generating',
      output: '機械翻訳は、ニューラルネットワークのおかげで、',
      startedAt: 'T-1',
      progress: {prefillSeconds: 0.12, decodeTokens: 9, decodeSeconds: 0.15},
      promptTokens: 26,
    },
    cachedModelIds: cached,
    text: SOURCE_TEXT,
  },
  // 言語を入れ替えて、翻訳先が日本語以外になった。
  swapped: {
    model: ready,
    translation: {...done, output: SOURCE_TEXT},
    cachedModelIds: cached,
    text: done.output,
    options: {source: 'ja', target: 'en', form: 'polite'},
  },
  stopping: {model: ready, translation: {kind: 'stopping', output: '', startedAt: 'T-12'}, cachedModelIds: cached, text: LONG_TEXT},
  // 長い訳文。欄は画面より高くならず、欄の中でスクロールする。
  'long-output': {
    model: ready,
    translation: {...done, output: Array.from({length: 60}, (_, i) => `${i + 1}. ${done.output}`).join('\n')},
    cachedModelIds: cached,
    text: SOURCE_TEXT,
  },
  // 共有している Engine で、ほかのタブの翻訳が終わるのを待っている。
  waiting: {
    model: ready,
    translation: {kind: 'generating', output: '', startedAt: 'T-3', progress: null, queued: true},
    cachedModelIds: cached,
    text: SOURCE_TEXT,
  },
  truncated: {
    model: ready,
    translation: {
      ...done,
      truncated: true,
      metrics: {
        ...done.metrics,
        prefillTokens: 6328,
        prefillTokensPerSecond: 719.3,
        decodeTokens: 1864,
        decodeTokensPerSecond: 37.84,
        decodeSeconds: 49.26,
        decodeChunks: 1863,
        contextTokens: 8192,
      },
    },
    cachedModelIds: cached,
    text: SOURCE_TEXT,
  },
  'input-too-long': {
    model: ready,
    translation: {
      kind: 'failed',
      output: '',
      error: {code: 'input-too-long', message: '原文が長すぎます (6,328 トークン、上限 2,048)。', action: '原文を分割するか、より大きいコンテキスト長で読み込み直してください。'},
    },
    cachedModelIds: cached,
    text: LONG_TEXT,
  },
  'gpu-lost': {
    model: {kind: 'failed', error: {code: 'gpu-lost', message: 'GPU が使えなくなりました。', action: 'モデルを読み込み直してください。解消しない場合はページを再読み込みしてください。'}},
    translation: {kind: 'idle'},
    cachedModelIds: cached,
    text: '',
  },
  unsupported: {
    model: {kind: 'unsupported', error: {code: 'webgpu-unavailable', message: 'このブラウザは WebGPU に対応していません。', action: '最新の Chrome か Edge をお使いください。'}},
    translation: {kind: 'idle'},
    cachedModelIds: [],
    text: '',
  },
};

async function apply(chrome, name, extra = {}) {
  const {text, ...patch} = states[name];
  const payload = JSON.stringify({
    options: {source: '', target: 'ja', form: ''},
    ...patch,
    selectedModelId: '0.8b-int8',
    selectedContextLength: 8192,
    ...extra,
  });
  await chrome.evaluate(`(() => {
    const patch = JSON.parse(${JSON.stringify(payload)});
    const translation = patch.translation;
    if (typeof translation.startedAt === 'string') {
      translation.startedAt = Date.now() - Number(translation.startedAt.slice(2)) * 1000;
    }
    window.plamoTranslator.update(patch);
    const area = document.querySelector('section[aria-label="翻訳"] textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(text)});
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await sleep(700);
}

const setTheme = async (chrome, theme) => {
  // 画面のボタンで切り替える。dataset を直接書き換えると、アイコンが切り替わらない。
  const label = theme === 'ink' ? 'ダークテーマに切り替える' : 'ライトテーマに切り替える';
  await chrome.evaluate(`document.querySelector('button[aria-label="${label}"]')?.click()`);
  await sleep(500); // 色の遷移が終わるのを待つ。
};

/** モデルの設定の欄を開閉する。見えている開閉ボタンを押す。 */
const toggleSettings = chrome =>
  chrome.evaluate(`[...document.querySelectorAll('section[aria-label="モデル"] [aria-expanded]')].find(b => b.offsetParent !== null)?.click()`);

/** 訳文の欄の高さ。画面の高さを超えていないか、長い訳文を欄の中でスクロールできるか。 */
const outputPaneFit = chrome =>
  chrome.evaluate(`(() => {
    const pane = document.querySelector('section[aria-label="訳文"]');
    const scroller = pane.querySelector('p[aria-live]')?.parentElement;
    return {pane: Math.round(pane.getBoundingClientRect().height), viewport: innerHeight, scrolls: scroller ? scroller.scrollHeight > scroller.clientHeight : false};
  })()`);

/** 横にはみ出していないか。 */
const overflow = chrome =>
  chrome.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);

rmSync(OUT, {recursive: true, force: true});
mkdirSync(OUT, {recursive: true});
const build = startProcess('bun run build --mode verify --outDir .verify/dist --emptyOutDir');
if ((await build.exited) !== 0) throw new Error(build.lines.join('\n'));
const server = startProcess('bun run preview --mode verify --outDir .verify/dist --port 5198 --strictPort --host 127.0.0.1');
await waitForHttp('http://127.0.0.1:5198/');
const chrome = await openChrome('screens');
try {
  await chrome.navigate('http://127.0.0.1:5198/');
  await chrome.waitState(`v.model.kind !== 'checking'`, 60000);

  await setTheme(chrome, 'paper');
  await chrome.setViewport(1536, 1024);
  for (const name of Object.keys(states)) {
    await apply(chrome, name);
    if (name === 'long-output') console.log(`desktop long-output: ${JSON.stringify(await outputPaneFit(chrome))}`);
    await chrome.screenshot(resolve(OUT, `desktop-${name}.png`));
  }

  await apply(chrome, 'ready');
  await chrome.evaluate(`document.querySelector('details').open = true`);
  await sleep(200);
  await chrome.screenshot(resolve(OUT, 'desktop-advanced.png'));
  await chrome.evaluate(`document.querySelector('details').open = false`);

  await toggleSettings(chrome);
  await sleep(200);
  await chrome.screenshot(resolve(OUT, 'desktop-settings.png'));
  await toggleSettings(chrome);

  await setTheme(chrome, 'ink');
  for (const name of ['ready', 'first-visit', 'downloading', 'stopping', 'input-too-long', 'waiting']) {
    await apply(chrome, name);
    await chrome.screenshot(resolve(OUT, `dark-${name}.png`));
  }

  await setTheme(chrome, 'paper');
  await chrome.setViewport(375, 812, true);
  for (const name of ['ready', 'first-visit', 'downloading', 'stopping', 'input-too-long', 'idle-cached', 'loading', 'generating', 'swapped', 'waiting', 'long-output']) {
    await apply(chrome, name);
    console.log(`mobile ${name}: horizontal overflow ${await overflow(chrome)} px`);
    if (name === 'long-output') console.log(`mobile long-output: ${JSON.stringify(await outputPaneFit(chrome))}`);
    await chrome.screenshot(resolve(OUT, `mobile-${name}.png`));
  }
  await apply(chrome, 'ready');
  await toggleSettings(chrome);
  await sleep(200);
  await chrome.screenshot(resolve(OUT, 'mobile-settings.png'));
  await toggleSettings(chrome);
  await setTheme(chrome, 'ink');
  await apply(chrome, 'ready');
  await chrome.screenshot(resolve(OUT, 'mobile-dark-ready.png'));

  console.log('exceptions:', chrome.observed.exceptions.slice(0, 5));
  console.log('csp or load errors:', chrome.observed.console.filter(entry => entry.type === 'error').map(entry => entry.text.slice(0, 200)).slice(0, 8));
} finally {
  await chrome.close();
  server.stop();
}
