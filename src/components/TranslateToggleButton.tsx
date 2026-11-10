import type {TranslationState} from '../inference/translatorStore';
import Icon from './Icon';

interface TranslateToggleButtonProps {
  translation: TranslationState;
  /** 翻訳を始められるか (モデルが準備完了で、原文が空でない)。 */
  canTranslate: boolean;
  onTranslate: () => void;
  onStop: () => void;
}

/**
 * 翻訳の開始と停止を 1 つのボタンで切り替える。
 * 要素を作り直さないので、押した後もフォーカスがボタンに残る。
 */
export default function TranslateToggleButton({translation, canTranslate, onTranslate, onStop}: TranslateToggleButtonProps) {
  const loading = translation.kind === 'loading';
  const generating = translation.kind === 'generating';
  const stopping = translation.kind === 'stopping';
  const running = generating || stopping;
  // モデルの読み込み中は止められない (読み込みが終わると翻訳が始まり、そこから止められる)。
  const label = loading ? '読み込み中' : stopping ? '停止中' : generating ? '停止する' : '翻訳する';
  return (
    <button
      type="button"
      className={`btn disabled:bg-base-content/15 disabled:text-base-content/50 w-full gap-1.5 text-base font-bold disabled:border-transparent md:w-36 ${
        running ? 'border-primary bg-base-100 text-primary hover:bg-base-200' : 'btn-primary'
      }`}
      disabled={loading || (running ? stopping : !canTranslate)}
      onClick={running ? onStop : onTranslate}
    >
      {running && <Icon name="stop" className="size-4" />}
      {label}
    </button>
  );
}
