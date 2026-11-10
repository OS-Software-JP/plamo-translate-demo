// 専用プロファイルのヘッドレス Chrome を CDP で操作する。普段使っている Chrome には触れない。
import {execFile, spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
/** 口調を使う設定か (src/config/tones.ts)。使わないときは、口調の項目を確かめない。 */
export const TONES_ENABLED = /TONES_ENABLED: boolean = true\b/.test(readFileSync(resolve(ROOT, 'src/config/tones.ts'), 'utf8'));
const CHROME = process.env.PLAMO_VERIFY_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const execFileAsync = promisify(execFile);
// 応答のない CDP の呼び出しで試験が止まり続けないようにする。evaluate の最長 (10 分) より長くする。
const CDP_CALL_TIMEOUT_MS = 15 * 60 * 1000;

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
    }),
  ]);
}

async function connect(url, onEvent) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, {once: true});
    ws.addEventListener('error', rej, {once: true});
  });
  const pending = new Map();
  let next = 0;
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    } else {
      onEvent(m);
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('CDP closed'));
    pending.clear();
  });
  return {
    call(method, params = {}, sessionId) {
      // 切れた接続に送っても応答は来ないので、待たずに失敗させる。
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP closed: ${method}`));
      return withTimeout(
        new Promise((res, rej) => {
          const id = ++next;
          pending.set(id, {resolve: res, reject: rej});
          ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
        }),
        CDP_CALL_TIMEOUT_MS,
        method,
      );
    },
    close: () => ws.close(),
  };
}

/** workerInit を渡すと、Worker のスクリプトが動く前にその式を Worker の中で評価する。 */
export async function openChrome(label, extraArgs = [], {workerInit} = {}) {
  const profile = resolve(ROOT, '.verify', 'profiles', `${label}-${Date.now()}`);
  mkdirSync(profile, {recursive: true});
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...extraArgs,
      'about:blank',
    ],
    {windowsHide: true, stdio: 'ignore'},
  );
  const portFile = resolve(profile, 'DevToolsActivePort');
  for (let i = 0; !existsSync(portFile); i++) {
    if (i > 150) throw new Error('Chrome startup timed out');
    await sleep(200);
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);

  const observed = {console: [], exceptions: [], requests: [], navigations: 0, workers: 0};
  let workerSession = null;
  const cdp = await connect(`ws://127.0.0.1:${port}${path}`, m => {
    const p = m.params ?? {};
    if (m.method === 'Target.attachedToTarget') {
      // SharedWorker は、推論を共有するときの Worker (src/inference/worker/shared.ts)。
      if (p.targetInfo.type === 'worker' || p.targetInfo.type === 'shared_worker') {
        observed.workers++;
        workerSession = p.sessionId;
      }
      for (const domain of ['Runtime', 'Network', 'Log']) cdp.call(`${domain}.enable`, {}, p.sessionId).catch(() => {});
      if (p.waitingForDebugger) {
        cdp
          .call('Runtime.evaluate', {expression: workerInit}, p.sessionId)
          .catch(() => {})
          .finally(() => cdp.call('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {}));
      }
    } else if (m.method === 'Runtime.exceptionThrown') {
      observed.exceptions.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '');
    } else if (m.method === 'Runtime.consoleAPICalled') {
      observed.console.push({type: p.type, text: p.args?.map(a => a.value ?? a.description ?? '').join(' ') ?? ''});
    } else if (m.method === 'Log.entryAdded') {
      observed.console.push({type: p.entry?.level, text: `${p.entry?.text ?? ''} ${p.entry?.url ?? ''}`});
    } else if (m.method === 'Network.requestWillBeSent') {
      if (p.request?.url) observed.requests.push(p.request.url);
    } else if (m.method === 'Page.frameNavigated' && !p.frame?.parentId) {
      observed.navigations++;
    }
  });
  const version = await cdp.call('Browser.getVersion');
  const {targetId} = await cdp.call('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await cdp.call('Target.attachToTarget', {targetId, flatten: true});
  for (const domain of ['Runtime', 'Page', 'Network', 'Log']) await cdp.call(`${domain}.enable`, {}, sessionId);
  await cdp.call('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: workerInit !== undefined, flatten: true}, sessionId);
  // SharedWorker はページの子ではないので、ブラウザ全体で接続する。
  await cdp.call('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: workerInit !== undefined,
    flatten: true,
    filter: [{type: 'shared_worker'}],
  });

  /** タブ (CDP のセッション) ごとの評価、移動、状態待ち。 */
  const sessionApi = sid => {
    const evaluate = async (expression, timeoutMs = 600000) => {
      const value = await withTimeout(
        cdp.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sid),
        timeoutMs,
        expression.slice(0, 100),
      );
      if (value.exceptionDetails) {
        throw new Error(value.exceptionDetails.exception?.description ?? JSON.stringify(value.exceptionDetails));
      }
      return value.result.value;
    };
    const navigate = async url => {
      await cdp.call('Page.navigate', {url}, sid);
      for (let i = 0; ; i++) {
        await sleep(100);
        try {
          if (await evaluate('typeof window.plamoTranslator === "object"', 5000)) return;
        } catch {
          // 読み込み中は評価に失敗することがある。
        }
        if (i > 1200) throw new Error('page did not become ready');
      }
    };
    /** 画面の状態が条件を満たすまで待つ。expression の中では v が状態を指す。 */
    const waitState = (expression, timeoutMs = 300000) =>
      evaluate(
        `(async () => {
          const store = window.plamoTranslator;
          const startedAt = Date.now();
          for (;;) {
            const v = store.getSnapshot();
            if (${expression}) return v;
            if (Date.now() - startedAt > ${timeoutMs}) throw new Error('state timeout: ' + JSON.stringify(v).slice(0, 400));
            await new Promise(r => setTimeout(r, 10));
          }
        })()`,
        timeoutMs + 5000,
      );
    return {evaluate, navigate, waitState};
  };
  const {evaluate, navigate, waitState} = sessionApi(sessionId);

  /** 同じブラウザ (同じプロファイル) に別のタブを開く。複数タブでの共有の確認に使う。 */
  const openTab = async url => {
    const created = await cdp.call('Target.createTarget', {url: 'about:blank'});
    const attached = await cdp.call('Target.attachToTarget', {targetId: created.targetId, flatten: true});
    for (const domain of ['Runtime', 'Page', 'Network', 'Log']) await cdp.call(`${domain}.enable`, {}, attached.sessionId);
    const api = sessionApi(attached.sessionId);
    await api.navigate(url);
    return {...api, close: () => cdp.call('Target.closeTarget', {targetId: created.targetId})};
  };

  const memoryScript = readFileSync(resolve(HERE, 'memory.ps1'), 'utf8');
  const gpuMemoryGiB = async () => {
    const {processInfo} = await cdp.call('SystemInfo.getProcessInfo');
    const ids = processInfo.map(p => p.id).join(',');
    const command = `& {\n${memoryScript}\n} -ProcessIds '${ids}'`;
    const {stdout} = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
      windowsHide: true,
      maxBuffer: 1 << 20,
    });
    return JSON.parse(stdout.trim()).gpu / 2 ** 30;
  };


  /** 画面の大きさを変える。 */
  const setViewport = async (width, height, mobile = false) => {
    await cdp.call(
      'Emulation.setDeviceMetricsOverride',
      {width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height},
      sessionId,
    );
    await sleep(150);
  };

  /** ページ全体を撮影する。 */
  const screenshot = async path => {
    await evaluate('document.fonts.ready.then(() => new Promise(r => setTimeout(r, 200)))', 30000);
    const {data} = await cdp.call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true}, sessionId);
    writeFileSync(path, Buffer.from(data, 'base64'));
  };

  /** 最後に起動した Worker の中で式を評価する。 */
  const evaluateInWorker = async expression => {
    const value = await cdp.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, workerSession);
    return value.result?.value ?? value.exceptionDetails?.exception?.description;
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await cdp.call('Browser.close');
    } catch {
      // すでに閉じている。
    }
    cdp.close();
    await sleep(1500);
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true});
    await sleep(500);
    try {
      rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 500});
    } catch {
      // 残っても次回の実行には影響しない。
    }
  };
  return {version, evaluate, evaluateInWorker, navigate, waitState, openTab, gpuMemoryGiB, setViewport, screenshot, observed, close};
}

export function startProcess(command, env = {}) {
  const lines = [];
  const child = spawn(command, {cwd: ROOT, shell: true, windowsHide: true, env: {...process.env, ...env}});
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', data => lines.push(...String(data).split(/\r?\n/).filter(Boolean)));
  }
  return {
    lines,
    exited: new Promise(r => child.on('exit', code => r(code))),
    stop: () => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true}),
  };
}

export async function waitForHttp(url, timeoutMs = 90000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // まだ起動していない。
    }
    if (Date.now() - startedAt > timeoutMs) throw new Error(`server did not start: ${url}`);
    await sleep(250);
  }
}
