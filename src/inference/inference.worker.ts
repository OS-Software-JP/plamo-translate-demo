// 専用 Worker の入口 (クラシック)。SDK が importScripts を使うので、モジュール Worker にはできない。
// ここに import / export を書くと (import type でも)、開発サーバーが末尾に `export {}` を残して
// 構文エラーになる。本体は動的 import で読むので、本体では普通に import を書ける。
{
  const queued: MessageEvent[] = [];
  self.onmessage = event => {
    queued.push(event);
  };
  void import('./worker/dedicated').then(({start}) => {
    start(queued);
  });
}
