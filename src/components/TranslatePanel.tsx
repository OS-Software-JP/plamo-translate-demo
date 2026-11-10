import {useState} from 'react';
import type {TranslatorActions} from '../hooks/useTranslator';
import {canStartTranslation, tonesAvailable, type TranslationState, type TranslatorState} from '../inference/translatorStore';
import AdvancedOptions from './AdvancedOptions';
import OutputPane from './OutputPane';
import type {PhaseValues} from './PhaseMetrics';
import SourcePane from './SourcePane';
import TranslateToggleButton from './TranslateToggleButton';
import TranslationOptionsRow from './TranslationOptionsRow';

const LONG_INPUT_CHARS = 10000;

/**
 * 原文の処理の速度 (実測)。プロンプトのトークン数 ÷ 最初の出力までの秒数。完了後も同じ測り方のまま変えない。
 * 最初の 1 トークンの生成なども含むので、SDK が測った原文の処理だけの速さより少し低い。
 */
const prefillSpeed = (tokens: number, seconds: number): number | undefined => (seconds > 0 ? tokens / seconds : undefined);

/**
 * 原文の処理の計測値。翻訳を始めるとトークン数 (Worker が数えた値) が分かり、
 * 最初の出力で秒数と速度が分かる。トークン数を数えられなかったときは、完了後に SDK の値で出す。
 */
function prefillOf(translation: TranslationState): PhaseValues | null {
  if (translation.kind === 'done') {
    const {prefillTokens, firstOutputSeconds} = translation.metrics;
    return {tokens: prefillTokens, seconds: firstOutputSeconds, tokensPerSecond: prefillSpeed(prefillTokens, firstOutputSeconds)};
  }
  if (translation.kind === 'generating') {
    const {promptTokens, progress} = translation;
    if (!progress) return promptTokens === undefined ? null : {tokens: promptTokens};
    const seconds = progress.prefillSeconds;
    return {tokens: promptTokens, seconds, tokensPerSecond: promptTokens === undefined ? undefined : prefillSpeed(promptTokens, seconds)};
  }
  return null;
}

/**
 * 生成中と完了後で共通の、訳文の生成の速度。最初の出力は時刻 0 に届くので、
 * 2 つ目以降に受け取ったチャンクの数を、最初から最後の出力までの秒数で割る。
 */
function measuredSpeed(chunks: number, seconds: number): number | undefined {
  return chunks > 1 && seconds > 0 ? (chunks - 1) / seconds : undefined;
}

/**
 * 訳文の生成の計測値。秒数と速度は、生成中も完了後も Worker で測った実測値で、完了時に変わらない。
 * トークン数だけは、完了時に SDK の値 (終わりの記号のトークンを含む) に置き換わる。
 * 上限は、コンテキスト長から原文の処理のトークン数を引いた残り (訳文に使える分)。
 * 段落ごとに分けて訳したとき (口調付きの翻訳) は、段落ごとの残りの合計 (Worker が送る decodeLimit)。
 */
function decodeOf(translation: TranslationState, contextLength: number): PhaseValues | null {
  if (translation.kind === 'done') {
    const {decodeTokens, decodeSeconds, decodeChunks, prefillTokens, decodeLimit} = translation.metrics;
    return {
      tokens: decodeTokens,
      limit: decodeLimit ?? translation.metrics.contextLength - prefillTokens,
      seconds: decodeSeconds,
      tokensPerSecond: measuredSpeed(decodeChunks, decodeSeconds),
    };
  }
  if (translation.kind === 'generating' && translation.progress) {
    const {decodeTokens, decodeSeconds} = translation.progress;
    const {promptTokens, decodeLimit} = translation;
    return {
      tokens: decodeTokens,
      limit: decodeLimit ?? (promptTokens === undefined ? undefined : contextLength - promptTokens),
      seconds: decodeSeconds,
      tokensPerSecond: measuredSpeed(decodeTokens, decodeSeconds),
    };
  }
  return null;
}

interface TranslatePanelProps {
  state: TranslatorState;
  actions: TranslatorActions;
}

export default function TranslatePanel({state, actions}: TranslatePanelProps) {
  // 原文は保存しない。参考文脈と用語集は設定として保存する (ストアの advanced)。
  const [text, setText] = useState('');
  const [outputLanguage, setOutputLanguage] = useState(state.options.target);

  const {translation, model, options, advanced} = state;
  const {context, glossary} = advanced;
  // 生成中の訳文の上限に使う。生成中は選択中の設定が読み込まれている。
  const contextLength = model.kind === 'ready' ? model.contextLength : state.selectedContextLength;
  // 保存済みのモデルなら、読み込まれていなくても翻訳を始められる (読み込んでから翻訳する)。
  const canTranslate = canStartTranslation(state) && text.trim() !== '';
  const longInput = text.length + context.length >= LONG_INPUT_CHARS;

  const submit = () => {
    if (!canTranslate) return;
    setOutputLanguage(options.target);
    void actions.translate({
      text,
      context: context || undefined,
      glossary: glossary.filter(entry => entry.source && entry.target),
    });
  };

  return (
    <section aria-label="翻訳" className="flex flex-col gap-4 md:flex-1">
      <TranslationOptionsRow
        options={options}
        actions={actions}
        tonesAvailable={tonesAvailable(state.selectedModelId)}
        action={
          <TranslateToggleButton
            translation={translation}
            canTranslate={canTranslate}
            onTranslate={submit}
            onStop={actions.stop}
          />
        }
      />

      <div className="border-base-300 bg-base-100 divide-base-300 grid grid-cols-1 divide-y border md:flex-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-[minmax(18rem,1fr)] md:divide-x md:divide-y-0">
        <SourcePane
          text={text}
          source={options.source}
          prefill={prefillOf(translation)}
          longInput={longInput}
          onChange={setText}
          onSubmit={submit}
        />
        <div className="md:min-h-0">
          <OutputPane
            translation={translation}
            language={outputLanguage}
            decode={decodeOf(translation, contextLength)}
          />
        </div>
      </div>

      <AdvancedOptions settings={advanced} onChange={actions.setAdvanced} />
    </section>
  );
}
