import {useState} from 'react';
import {outputFontClass} from '../config/fonts';
import {useElapsedSeconds} from '../hooks/useElapsedSeconds';
import {shortenAction} from '../inference/errors';
import type {TranslationState} from '../inference/translatorStore';
import ErrorAlert from './ErrorAlert';
import Icon from './Icon';
import PhaseMetrics, {type PhaseValues} from './PhaseMetrics';
import Spinner from './Spinner';

interface OutputPaneProps {
  translation: TranslationState;
  /** 訳文の言語。 */
  language: string;
  /** 訳文の生成の計測値。生成中は逐次の値、完了後は SDK の値。 */
  decode: PhaseValues | null;
  className?: string;
}

const COPIED_FEEDBACK_MS = 1500;

/** 見開きの右のページ。 */
export default function OutputPane({translation, language, decode, className = ''}: OutputPaneProps) {
  const [copied, setCopied] = useState(false);
  const output = 'output' in translation ? translation.output : '';
  const loading = translation.kind === 'loading';
  const processing = translation.kind === 'generating' && output === '';
  const stopping = translation.kind === 'stopping';
  // 共有している Engine で、ほかのタブの翻訳が終わるのを待っている。
  const waiting = translation.kind === 'generating' && translation.queued === true;
  const elapsed = useElapsedSeconds(loading || processing || stopping ? translation.startedAt : null);

  const copy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  // 長い訳文で欄が画面より高くならないようにする。スマートフォン幅は高さに上限を設け、
  // 広い画面は訳文を欄の高さの計算に入れない (contain: size)。どちらも訳文は欄の中でスクロールする。
  return (
    <section
      aria-label="訳文"
      className={`flex max-h-[80dvh] min-h-48 flex-col px-4 md:h-full md:max-h-none md:px-8 ${className}`}
    >
      <div className="border-base-300 flex h-10 shrink-0 items-center justify-between border-b md:h-12">
        <h2 className="font-serif text-sm leading-none font-normal tracking-[0.1em]">訳文</h2>
        <button
          type="button"
          className="btn btn-ghost btn-square btn-sm text-base-content/80 hover:text-base-content -mr-1.5 disabled:bg-transparent"
          aria-label={copied ? 'コピーしました' : '訳文をコピー'}
          disabled={!output}
          onClick={() => void copy()}
        >
          <Icon name={copied ? 'check' : 'copy'} className="size-[1.125rem]" />
        </button>
      </div>

      {loading || processing || stopping ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-2 py-6 text-center" role="status">
          <Spinner className="size-10 border-4" />
          <p className="max-w-xl text-balance">
            {loading
              ? 'モデルを読み込んでいます。読み込みが終わると翻訳を始めます。'
              : stopping
                ? '原文の処理が終わると停止します。それまで次の翻訳やモデルの切り替えはできません。'
                : waiting
                  ? '別のタブの翻訳が終わるのを待っています。終わると翻訳を始めます。'
                  : '原文を処理しています。'}
          </p>
          <p className="text-sm tabular-nums">経過 {elapsed} 秒</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto py-3 md:py-4 md:[contain:size]">
          <p
            className={`text-[0.9375rem] leading-[1.8] wrap-anywhere whitespace-pre-wrap md:text-lg md:leading-[1.8] ${outputFontClass(language)}`}
            dir="auto"
            lang={language}
            aria-live="polite"
          >
            {output}
          </p>
          {translation.kind === 'done' && translation.truncated && (
            <div role="alert" className="alert alert-warning alert-soft text-sm md:text-base">
              上限に達したので訳文が途中で切れています。{shortenAction(translation.used)}
            </div>
          )}
          {translation.kind === 'stopped' && <p className="text-sm">停止しました。</p>}
          {translation.kind === 'failed' && <ErrorAlert error={translation.error} />}
        </div>
      )}

      {/* 広い画面では左右のページの罫線を揃えるため、計測値がなくても行を残す。 */}
      <div className={`border-base-300 items-center border-t py-2 md:flex md:min-h-10 ${decode ? 'flex' : 'hidden'}`}>
        {decode && <PhaseMetrics label="訳文の生成" secondsTitle="生成にかかった時間" {...decode} className="ml-auto" />}
      </div>
    </section>
  );
}
