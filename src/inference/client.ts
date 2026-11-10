// Worker の起動、破棄、メッセージの送受信。
// SharedWorker を使えるブラウザでは、同じ shareKey のクライアントが、タブをまたいで 1 つの SharedWorker
// (1 つの Engine) を共有する。使えないブラウザでは、クライアントごとに専用 Worker を作る。
import type {
  SharedHello,
  SharedHelloReply,
  WorkerApi,
  WorkerEvent,
  WorkerFailure,
  WorkerMessage,
  WorkerMethod,
  WorkerRequest,
} from './protocol';

/** 返事がなければ、終了しかけの SharedWorker につながったとみなして、別の名前でやり直す。 */
const HELLO_TIMEOUT_MS = 8000;
const MAX_CONNECT_ATTEMPTS = 3;
/**
 * 版の違うページが同じ名前の SharedWorker につながらないよう、名前にこのモジュールの場所を含める。
 * 公開版ではビルドごとにファイル名が変わる。スクリプトの URL が違うと、同じ名前では接続できない。
 */
const BUILD = new URL(import.meta.url).pathname;

export class WorkerCallError extends Error {
  readonly failure: WorkerFailure;

  constructor(failure: WorkerFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface InferenceClientHandlers {
  onEvent?: (event: WorkerEvent) => void;
  /** Worker が処理を続けられなくなったとき。 */
  onCrash?: (message: string) => void;
}

type Post = (request: WorkerRequest) => void;

export class InferenceClient {
  private readonly handlers: InferenceClientHandlers;
  private readonly pending = new Map<number, Pending>();
  private readonly connected: Promise<Post>;
  /** SharedWorker の停止の見張りを、破棄したときにやめる。 */
  private readonly watch = new AbortController();
  private dispose: () => void = () => {};
  private nextId = 0;
  private closed = false;

  /** shareKey が同じクライアントは Engine を共有する。省略すると共有しない。 */
  constructor(handlers: InferenceClientHandlers = {}, shareKey?: string) {
    this.handlers = handlers;
    this.connected =
      typeof SharedWorker === 'function'
        ? this.connectShared(shareKey ?? `private:${crypto.randomUUID()}`)
        : Promise.resolve(this.startDedicated());
    // 失敗は call() が返す。
    this.connected.catch(() => {});
  }

  call<M extends WorkerMethod>(method: M, ...args: Parameters<WorkerApi[M]>): Promise<ReturnType<WorkerApi[M]>> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('worker is terminated'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, {resolve: resolve as (value: unknown) => void, reject});
      this.connected.then(
        post => {
          if (!this.closed) post({id, method, args} as WorkerRequest);
        },
        (error: unknown) => {
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** Worker を破棄する (共有中ならこのクライアントだけ外れる)。未完了の呼び出しは失敗する。 */
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.watch.abort();
    this.dispose();
    for (const {reject} of this.pending.values()) reject(new Error('worker is terminated'));
    this.pending.clear();
  }

  private receive(data: WorkerMessage): void {
    if (this.closed) return;
    if ('event' in data) {
      this.handlers.onEvent?.(data);
      return;
    }
    const entry = this.pending.get(data.id);
    if (!entry) return;
    this.pending.delete(data.id);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new WorkerCallError(data.failure));
  }

  private crash(message: string): void {
    if (!this.closed) this.handlers.onCrash?.(message);
  }

  private startDedicated(): Post {
    // SDK が importScripts を使うので、type: 'module' を付けない。
    const worker = new Worker(new URL('./inference.worker.ts', import.meta.url));
    worker.onmessage = ({data}: MessageEvent<WorkerMessage>) => this.receive(data);
    worker.onerror = event => this.crash(event.message || 'worker error');
    this.dispose = () => worker.terminate();
    return request => worker.postMessage(request);
  }

  private async connectShared(shareKey: string): Promise<Post> {
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
      if (this.closed) break;
      const name = `plamo:${shareKey}:${BUILD}${attempt ? `#${attempt}` : ''}`;
      const post = await this.tryConnect(name);
      if (post) return post;
    }
    throw new Error(this.closed ? 'worker is terminated' : 'shared worker is not available');
  }

  /** 1 つの名前で接続を試す。断られたか返事がなければ null を返す。 */
  private async tryConnect(name: string): Promise<Post | null> {
    // 接続している間は持ち続けるロック。解放すると (破棄かタブを閉じたとき)、SharedWorker がこの接続を外す。
    const clientLock = `plamo-client:${crypto.randomUUID()}`;
    let release = () => {};
    await new Promise<void>(held => {
      void navigator.locks.request(clientLock, () => {
        held();
        return new Promise<void>(resolve => {
          release = resolve;
        });
      });
    });
    if (this.closed) {
      release();
      return null;
    }

    // SharedWorker でも、SDK が importScripts を使うので type: 'module' を付けない。
    const worker = new SharedWorker(new URL('./inference.shared.ts', import.meta.url), {name});
    const {port} = worker;
    const reply = await new Promise<SharedHelloReply | null>(resolve => {
      const timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS);
      worker.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      port.onmessage = ({data}: MessageEvent<WorkerMessage | SharedHelloReply>) => {
        if (!('hello' in data)) return;
        clearTimeout(timer);
        resolve(data);
      };
      port.postMessage({hello: {clientLock}} satisfies SharedHello);
    });
    if (reply?.hello !== 'accepted' || this.closed) {
      port.close();
      release();
      return null;
    }

    port.onmessage = ({data}: MessageEvent<WorkerMessage>) => this.receive(data);
    // SharedWorker が止まると、持っていたロックが解放されて、ここで取得できる。
    navigator.locks
      .request(reply.aliveLock, {signal: this.watch.signal}, () => this.crash('shared worker stopped'))
      .catch(() => {});
    this.dispose = () => {
      port.close();
      release();
    };
    return request => port.postMessage(request);
  }
}
