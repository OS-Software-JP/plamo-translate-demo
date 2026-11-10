import {CONTEXT_LENGTHS, MODELS, isContextLength, type ContextLength, type ModelDefinition, type ModelId} from '../config/models';
import type {TranslatorActions} from '../hooks/useTranslator';
import {formatBytes} from '../utils/format';

interface ModelSettingsProps {
  id: string;
  open: boolean;
  selected: ModelDefinition;
  selectedContextLength: ContextLength;
  unavailableModelIds: readonly ModelId[];
  cached: boolean;
  /** 選択欄を無効にする (読み込み中、翻訳中、環境の確認中、非対応)。 */
  disabled: boolean;
  busy: boolean;
  actions: TranslatorActions;
}

/** モデルとコンテキスト長の選択と、保存したモデルの削除。閉じている間も要素は残し、選んだ値を保つ。 */
export default function ModelSettings({
  id,
  open,
  selected,
  selectedContextLength,
  unavailableModelIds,
  cached,
  disabled,
  busy,
  actions,
}: ModelSettingsProps) {
  return (
    <div
      id={id}
      hidden={!open}
      className="border-base-300 flex flex-col gap-3 border-b px-1 pt-1 pb-3 md:flex-row md:flex-wrap md:items-end md:gap-x-5 md:pb-4"
    >
      <label className="flex flex-col gap-1 text-sm">
        モデル
        <select
          className="select border-base-300 bg-base-100 w-full md:w-[25rem] md:text-base"
          value={selected.id}
          disabled={disabled}
          onChange={event => actions.selectModel(event.target.value as ModelId)}
        >
          {MODELS.map(option => (
            <option key={option.id} value={option.id} disabled={unavailableModelIds.includes(option.id)}>
              {option.label} ({formatBytes(option.sizeBytes)})
              {unavailableModelIds.includes(option.id) ? ' (この GPU では使えません)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {/* 参考文脈と用語集もコンテキスト長を使う。括弧の中では折り返さず、狭い画面では括弧の前で改行する。 */}
        <span>
          コンテキスト長 <span className="whitespace-nowrap">(原文・参考文脈・用語集・訳文の合計の上限)</span>
        </span>
        <select
          className="select border-base-300 bg-base-100 w-full md:w-[23rem] md:text-base"
          value={selectedContextLength}
          disabled={disabled}
          onChange={event => {
            const value = Number(event.target.value);
            if (isContextLength(value)) actions.selectContextLength(value);
          }}
        >
          {CONTEXT_LENGTHS.map(length => (
            <option key={length} value={length}>
              {length} トークン (GPU メモリ {selected.gpuMemoryGiB[length].toFixed(2)} GiB)
            </option>
          ))}
        </select>
      </label>
      {cached && (
        <button
          type="button"
          className="btn border-base-300 bg-base-100 hover:bg-base-200 md:ml-auto"
          disabled={busy}
          onClick={() => void actions.deleteModel(selected.id)}
        >
          このブラウザから削除
        </button>
      )}
    </div>
  );
}
