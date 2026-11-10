// SharedWorker として動かす。同じ名前 (モデル、コンテキスト長、ビルド) で接続したタブは、1 つの Engine を共有する。
// GPU のメモリを使う Engine は 1 つなので、同じ設定のタブを増やしてもメモリは増えない。
//
// - 接続の終わり: タブが持つロック (clientLock) が解放されたら、その接続を外す。タブを閉じても解放される。
// - 終了: 接続がなくなったら自分で終了し、GPU のメモリを解放する (専用 Worker の terminate にあたる)。
// - 読み込み: 最初の依頼で読み込み、後から来た依頼は同じ読み込みを待つ。
// - 翻訳: 届いた順に 1 件ずつ処理する。訳文のイベントは依頼したタブにだけ送る。待たせるときは queued を、
//   待ち終えて始めるときは started を、依頼したタブに送る。
// - 使えなくなったとき: GPU のエラーか読み込みの失敗の後は、新しい接続を断る。Engine は 1 つの Worker で
//   一度しか作れないので、断られたタブは別の名前の SharedWorker で読み込み直す。
import type {
  LoadRequest,
  LoadResult,
  SharedHello,
  SharedHelloReply,
  TranslationRequest,
  WorkerEvent,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
} from '../protocol';
import {handle, handlers, setEventSink} from './main';

interface Connection {
  readonly port: MessagePort;
}

interface QueuedTranslation {
  readonly connection: Connection;
  readonly id: number;
  readonly request: TranslationRequest;
  /** ほかのタブの翻訳を待った。始めるときに started を送る。 */
  waited: boolean;
}

const scope = self as unknown as {onconnect: ((event: MessageEvent) => void) | null; close: () => void};
const connections = new Set<Connection>();
/** 読み込みの結果を待っている呼び出しの ID。 */
const loadWaiters = new Map<Connection, number[]>();
const translations: QueuedTranslation[] = [];
let running: QueuedTranslation | null = null;
let loading: Promise<WorkerResponse> | null = null;
let loaded = false;
let broken = false;

const aliveLock = `plamo-host:${crypto.randomUUID()}`;
/** 終了するまでロックを持ち続ける。タブはその解放で、この SharedWorker が止まったことを知る。 */
const aliveHeld = new Promise<void>(held => {
  void navigator.locks.request(aliveLock, () => {
    held();
    return new Promise<never>(() => {});
  });
});

function send(connection: Connection, message: WorkerMessage | SharedHelloReply): void {
  connection.port.postMessage(message);
}

function onEvent(event: WorkerEvent): void {
  // 訳文とプロンプトのトークン数は、翻訳を依頼したタブにだけ送る。
  if (event.event === 'output' || event.event === 'prompt') {
    if (running) send(running.connection, event);
    return;
  }
  if (event.event === 'gpuError' || event.event === 'gpuLost') broken = true;
  for (const connection of connections) send(connection, event);
}

function removeQueued(connection: Connection): QueuedTranslation[] {
  const removed = translations.filter(entry => entry.connection === connection);
  for (const entry of removed) translations.splice(translations.indexOf(entry), 1);
  return removed;
}

function detach(connection: Connection): void {
  if (!connections.delete(connection)) return;
  loadWaiters.delete(connection);
  removeQueued(connection);
  // 依頼したタブがいなくなった翻訳は止めて、ほかのタブの翻訳を早く始める。
  if (running?.connection === connection) handlers.stop();
  connection.port.close();
  // 接続がなくなったら終了して、GPU のメモリを解放する。読み込み中や翻訳中でも止める。
  if (connections.size === 0) scope.close();
}

async function accept(connection: Connection, {clientLock}: SharedHello['hello']): Promise<void> {
  if (broken) {
    send(connection, {hello: 'rejected'});
    connection.port.close();
    return;
  }
  connections.add(connection);
  await aliveHeld;
  send(connection, {hello: 'accepted', aliveLock});
  // タブがロックを解放すると (接続の破棄かタブを閉じたとき)、ここで取得できる。
  void navigator.locks.request(clientLock, () => detach(connection));
}

async function load(connection: Connection, id: number, request: LoadRequest): Promise<void> {
  const requestedAt = performance.now();
  const alreadyLoaded = loaded;
  loadWaiters.set(connection, [...(loadWaiters.get(connection) ?? []), id]);
  loading ??= handle({id, method: 'load', args: [request]});
  const response = await loading;
  if (response.ok) loaded = true;
  else broken = true;

  const ids = loadWaiters.get(connection) ?? [];
  // 中止したか、接続が外れた。
  if (!ids.includes(id)) return;
  const rest = ids.filter(value => value !== id);
  if (rest.length) loadWaiters.set(connection, rest);
  else loadWaiters.delete(connection);

  if (response.ok && alreadyLoaded) {
    // ほかのタブが読み込んだ Engine をそのまま使う。読み込みの秒数は、このタブが待った時間にする。
    const result: LoadResult = {loadSeconds: (performance.now() - requestedAt) / 1000, downloaded: false};
    send(connection, {id, ok: true, result});
  } else {
    send(connection, {...response, id});
  }
}

/** このタブだけ読み込みの待ちをやめる。ほかに待っているタブがなければ、ダウンロードを止める。 */
function cancelDownload(connection: Connection): void {
  const ids = loadWaiters.get(connection);
  if (!ids || loaded) return;
  loadWaiters.delete(connection);
  for (const id of ids) send(connection, {id, ok: false, failure: {code: 'download-cancelled', message: 'download cancelled'}});
  if (loadWaiters.size === 0) handlers.cancelDownload();
}

function pump(): void {
  if (running) return;
  const next = translations.shift();
  if (!next) return;
  running = next;
  if (next.waited) send(next.connection, {event: 'started'});
  void handle({id: next.id, method: 'translate', args: [next.request]}).then(response => {
    running = null;
    if (connections.has(next.connection)) send(next.connection, response);
    pump();
  });
}

/** このタブの翻訳を止める。順番待ちの翻訳は、始めずに停止として返す。 */
function stop(connection: Connection): void {
  if (running?.connection === connection) handlers.stop();
  for (const entry of removeQueued(connection)) send(connection, {id: entry.id, ok: true, result: {kind: 'stopped', output: ''}});
}

function receive(connection: Connection, data: SharedHello | WorkerRequest): void {
  if ('hello' in data) {
    void accept(connection, data.hello);
    return;
  }
  if (!connections.has(connection)) return;
  switch (data.method) {
    case 'load':
      void load(connection, data.id, data.args[0]);
      break;
    case 'cancelDownload':
      cancelDownload(connection);
      send(connection, {id: data.id, ok: true, result: true});
      break;
    case 'translate': {
      const entry: QueuedTranslation = {connection, id: data.id, request: data.args[0], waited: false};
      translations.push(entry);
      pump();
      // すぐに始められなければ、待っていることを知らせる。
      if (running !== entry) {
        entry.waited = true;
        send(connection, {event: 'queued'});
      }
      break;
    }
    case 'stop':
      stop(connection);
      send(connection, {id: data.id, ok: true, result: true});
      break;
    default:
      // 環境の確認、保存済みのモデルの一覧と削除。Engine を使わないので、そのまま処理する。
      void handle(data).then(response => send(connection, response));
  }
}

/** 入口のコードが受け取っておいた接続を処理してから、以後の接続に切り替える。 */
export function start(queued: MessageEvent[]): void {
  setEventSink(onEvent);
  const onConnect = (event: MessageEvent) => {
    const connection: Connection = {port: event.ports[0]};
    connection.port.onmessage = ({data}: MessageEvent<SharedHello | WorkerRequest>) => receive(connection, data);
  };
  scope.onconnect = onConnect;
  for (const event of queued) onConnect(event);
}
