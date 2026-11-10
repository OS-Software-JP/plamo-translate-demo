import {useId, useRef} from 'react';
import {sourceFontClass} from '../config/fonts';
import Icon from './Icon';
import PhaseMetrics, {type PhaseValues} from './PhaseMetrics';

interface SourcePaneProps {
  text: string;
  source: string;
  /** 原文の処理の計測値。生成が始まると秒数が分かり、完了するとトークン数と速度が分かる。 */
  prefill: PhaseValues | null;
  /** 長い原文のときの注意を表示する。 */
  longInput: boolean;
  className?: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
}

/** 見開きの左のページ。柱 (見出しの行)、本文、ノンブルの位置の計測値を、右のページと同じ高さに揃える。 */
export default function SourcePane({text, source, prefill, longInput, className = '', onChange, onSubmit}: SourcePaneProps) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const clear = () => {
    onChange('');
    // 消した後、そのまま次の文章を入力できるようにする。
    area.current?.focus();
  };
  return (
    <div className={`flex min-h-48 flex-col px-4 md:h-full md:min-h-0 md:px-8 ${className}`}>
      <div className="border-base-300 flex h-10 shrink-0 items-center justify-between border-b md:h-12">
        <label htmlFor={id} className="font-serif text-sm leading-none tracking-[0.1em]">
          原文
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-square btn-sm text-base-content/80 hover:text-base-content -mr-1.5 disabled:bg-transparent"
          aria-label="原文を消去"
          disabled={text === ''}
          onClick={clear}
        >
          <Icon name="close" className="size-[1.125rem]" />
        </button>
      </div>
      <textarea
        id={id}
        ref={area}
        className={`w-full flex-1 resize-none bg-transparent py-3 text-[0.9375rem] leading-[1.8] outline-none md:py-4 md:text-lg md:leading-[1.8] ${sourceFontClass(source)}`}
        dir="auto"
        lang={source || undefined}
        placeholder="翻訳する文章を入力してください"
        value={text}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {/* 広い画面では左右のページの罫線を揃えるため、計測値がなくても行を残す。 */}
      <div
        className={`border-base-300 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t py-2 md:flex md:min-h-10 ${longInput || prefill ? 'flex' : 'hidden'}`}
      >
        {longInput && <p className="text-sm">処理に時間がかかり、途中で止められません。</p>}
        {prefill && <PhaseMetrics label="原文の処理" secondsTitle="最初の出力までの時間" {...prefill} className="ml-auto" />}
      </div>
    </div>
  );
}
