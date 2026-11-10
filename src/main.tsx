import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root が見つかりません');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 開発環境専用の照合手段 (scripts/verify) から状態を操作するための入口。
if (import.meta.env.DEV || import.meta.env.MODE === 'verify') {
  void import('./inference/translatorStore').then(({translatorStore}) => {
    (window as unknown as {plamoTranslator: typeof translatorStore}).plamoTranslator = translatorStore;
  });
}
