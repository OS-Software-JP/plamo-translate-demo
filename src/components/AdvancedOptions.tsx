import type {GlossaryEntry} from '../inference/protocol';
import type {AdvancedSettings} from '../inference/translatorStore';
import Icon from './Icon';

interface AdvancedOptionsProps {
  settings: AdvancedSettings;
  /** 変えた項目を渡す。ストアが保存し、再読み込みしても残る。 */
  onChange: (patch: Partial<AdvancedSettings>) => void;
}

/** 参考文脈と用語集。入力した内容と欄の開閉は、このブラウザに保存する。 */
export default function AdvancedOptions({settings, onChange}: AdvancedOptionsProps) {
  const {context, glossary, open} = settings;
  const onGlossaryChange = (next: GlossaryEntry[]) => onChange({glossary: next});
  const updateEntry = (index: number, patch: Partial<GlossaryEntry>) => {
    onGlossaryChange(glossary.map((entry, i) => (i === index ? {...entry, ...patch} : entry)));
  };
  return (
    <details
      className="group border-base-300 border-y"
      open={open}
      onToggle={event => {
        if (event.currentTarget.open !== open) onChange({open: event.currentTarget.open});
      }}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-1 font-bold [&::-webkit-details-marker]:hidden">
        <Icon name="chevron-right" className="size-5 shrink-0 transition-transform group-open:rotate-90" />
        詳細オプション (参考文脈・用語集)
      </summary>
      <div className="flex flex-col gap-4 px-1 pb-5">
        <label className="flex flex-col gap-1 text-sm">
          参考文脈
          <textarea
            className="textarea border-base-300 bg-base-100 h-24 w-full md:text-base"
            dir="auto"
            placeholder="前後の文章や場面など、原文を解釈するための情報"
            value={context}
            onChange={event => onChange({context: event.target.value})}
          />
        </label>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">用語集</legend>
          {glossary.map((entry, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                className="input border-base-300 bg-base-100 min-w-0 flex-1 md:text-base"
                aria-label={`原語 ${index + 1}`}
                placeholder="原語"
                dir="auto"
                value={entry.source}
                onChange={event => updateEntry(index, {source: event.target.value})}
              />
              <input
                className="input border-base-300 bg-base-100 min-w-0 flex-1 md:text-base"
                aria-label={`訳語 ${index + 1}`}
                placeholder="訳語"
                dir="auto"
                value={entry.target}
                onChange={event => updateEntry(index, {target: event.target.value})}
              />
              <button
                type="button"
                className="btn btn-square btn-sm border-base-300 bg-base-100 hover:bg-base-200 shrink-0"
                aria-label={`用語 ${index + 1} を削除`}
                onClick={() => onGlossaryChange(glossary.filter((_, i) => i !== index))}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="btn btn-sm border-base-300 bg-base-100 hover:bg-base-200 text-sm"
              onClick={() => onGlossaryChange([...glossary, {source: '', target: ''}])}
            >
              用語を追加
            </button>
          </div>
        </fieldset>
      </div>
    </details>
  );
}
