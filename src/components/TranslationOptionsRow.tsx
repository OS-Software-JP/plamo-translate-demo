import type {ReactNode} from 'react';
import {LANGUAGES} from '../config/languages';
import {TONES, TONES_ENABLED, isToneId} from '../config/tones';
import type {TranslatorActions} from '../hooks/useTranslator';
import type {FormOption, TranslationOptions} from '../inference/translatorStore';
import Icon from './Icon';

interface TranslationOptionsRowProps {
  options: TranslationOptions;
  actions: TranslatorActions;
  /** 文体の右に置く操作 (翻訳と停止を切り替えるボタン)。 */
  action: ReactNode;
  /** 選択中のモデルで口調 (お嬢様言葉など) を選べるか。口調の行を学習したのは 0.8B だけ。 */
  tonesAvailable: boolean;
}

const languageOptions = LANGUAGES.map(language => (
  <option key={language.code} value={language.code}>
    {language.label}
  </option>
));

/** 翻訳元、翻訳先、文体の選択と、翻訳の操作。 */
export default function TranslationOptionsRow({options, actions, action, tonesAvailable}: TranslationOptionsRowProps) {
  const {source, target, form} = options;
  const formEnabled = target === 'ja';
  // 口調を選べないとき (2B、8B、または口調を使わない設定) は「指定なし」と表示する。選んだ口調は覚えておき、0.8B に戻すと使う。
  const shownForm = !formEnabled || (isToneId(form) && !tonesAvailable) ? '' : form;
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
      <div className="flex w-full items-end gap-2 md:w-auto md:gap-5">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm tracking-[0.1em] md:w-60 md:flex-none">
          翻訳元
          <select
            className="select border-base-300 bg-base-100 w-full font-semibold tracking-normal md:text-base"
            value={source}
            onChange={event => actions.setOptions({source: event.target.value})}
          >
            <option value="">自動</option>
            {languageOptions}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-square border-base-300 bg-base-100 hover:bg-base-200 shrink-0"
          aria-label="翻訳元と翻訳先を入れ替える"
          disabled={!source}
          onClick={() => actions.setOptions({source: target, target: source})}
        >
          <Icon name="swap" />
        </button>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm tracking-[0.1em] md:w-64 md:flex-none">
          翻訳先
          <select
            className="select border-base-300 bg-base-100 w-full font-semibold tracking-normal md:text-base"
            value={target}
            onChange={event => actions.setOptions({target: event.target.value})}
          >
            {languageOptions}
          </select>
        </label>
      </div>
      <div className="flex w-full items-end gap-2 md:w-auto md:gap-5 xl:flex-1">
        {/* 言語を入れ替えても場所が動かないよう、文体は常に表示し、日本語以外では選べなくする。
            選んだ文体は覚えておき、翻訳先を日本語に戻すと使う。 */}
        <label
          className="flex min-w-0 flex-1 flex-col gap-1 text-sm tracking-[0.1em] md:w-64 md:flex-none"
          title={formEnabled ? undefined : '文体は翻訳先が日本語のときだけ選べます'}
        >
          文体
          <select
            className="select border-base-300 bg-base-100 w-full font-semibold tracking-normal md:text-base"
            value={shownForm}
            disabled={!formEnabled}
            onChange={event => actions.setOptions({form: event.target.value as FormOption | ''})}
          >
            <option value="">{formEnabled ? '指定なし' : '日本語のみ'}</option>
            <option value="polite">敬体</option>
            <option value="plain">常体</option>
            {/* 翻訳先を ja-easy にして依頼する (translatorStore の translate)。 */}
            <option value="easy">やさしい日本語</option>
            {/* 翻訳先を口調の予約トークンにして依頼する (config/tones.ts)。 */}
            {TONES_ENABLED && (
              <optgroup label={tonesAvailable ? '口調' : '口調 (0.8B のみ)'}>
                {TONES.map(tone => (
                  <option key={tone.id} value={tone.id} disabled={!tonesAvailable}>
                    {tone.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <div className="w-32 shrink-0 md:w-auto xl:ml-auto">{action}</div>
      </div>
    </div>
  );
}
