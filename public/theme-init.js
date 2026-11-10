// 描画の前に、保存したテーマを適用する。保存がなければ OS の設定に従う。
try {
  const theme = localStorage.getItem('plamo-translate-demo:theme');
  if (theme === 'paper' || theme === 'ink') document.documentElement.dataset.theme = theme;
} catch {
  // 読めなくても OS の設定で表示できる。
}
