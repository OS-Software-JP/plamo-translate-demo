// SharedWorker の入口 (クラシック)。制約は inference.worker.ts と同じ。
{
  const queued: MessageEvent[] = [];
  (self as unknown as {onconnect: (event: MessageEvent) => void}).onconnect = event => {
    queued.push(event);
  };
  void import('./worker/shared').then(({start}) => {
    start(queued);
  });
}
