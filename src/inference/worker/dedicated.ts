// 専用 Worker として動かす。SharedWorker を使えないブラウザで使う。
import type {WorkerRequest} from '../protocol';
import {handle, setEventSink} from './main';

/** 入口のコードが受け取っておいたメッセージを処理してから、以後の受信に切り替える。 */
export function start(queued: MessageEvent[]): void {
  setEventSink(event => postMessage(event));
  const receive = (event: MessageEvent<WorkerRequest>) => void handle(event.data).then(response => postMessage(response));
  self.onmessage = receive;
  for (const event of queued) receive(event);
}
