import {useCallback, useState} from 'react';

export type Theme = 'paper' | 'ink';

const STORAGE_KEY = 'plamo-translate-demo:theme';

function currentTheme(): Theme {
  const applied = document.documentElement.dataset.theme;
  if (applied === 'paper' || applied === 'ink') return applied;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'ink' : 'paper';
}

/** ライトとダークを切り替える。最初の適用は public/theme-init.js が行う。 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === 'ink' ? 'paper' : 'ink';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 保存できなくても、このページの間は切り替わる。
    }
    setTheme(next);
  }, []);
  return {theme, toggle};
}
