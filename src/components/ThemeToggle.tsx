import {useTheme} from '../hooks/useTheme';
import Icon from './Icon';

export default function ThemeToggle() {
  const {theme, toggle} = useTheme();
  const dark = theme === 'ink';
  return (
    <button
      type="button"
      className="btn btn-square border-base-300 bg-base-100 hover:bg-base-200 shrink-0"
      aria-label={dark ? 'ライトテーマに切り替える' : 'ダークテーマに切り替える'}
      onClick={toggle}
    >
      <Icon name={dark ? 'sun' : 'moon'} className="size-6" />
    </button>
  );
}
