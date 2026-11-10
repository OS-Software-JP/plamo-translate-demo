import {memo, useId, useState} from 'react';
import {getModel, type ContextLength, type ModelId} from '../config/models';
import type {TranslatorActions} from '../hooks/useTranslator';
import type {ModelState} from '../inference/translatorStore';
import {formatBytes} from '../utils/format';
import Icon from './Icon';
import ModelActions from './ModelActions';
import ModelNotice from './ModelNotice';
import ModelSettings from './ModelSettings';
import ModelStatusBadge from './ModelStatusBadge';

interface ModelPanelProps {
  model: ModelState;
  selectedModelId: ModelId;
  selectedContextLength: ContextLength;
  cachedModelIds: readonly ModelId[];
  unavailableModelIds: readonly ModelId[];
  gpuDescription: string;
  /** 翻訳中と停止中。モデルを操作できない。 */
  translating: boolean;
  actions: TranslatorActions;
}

/**
 * 選んでいるモデルと状態、次の操作を 1 本のバーにまとめる。
 * 広い画面は「名前と補足 | 状態 | 操作」の 1 行、スマートフォン幅は「名前と開閉 / 状態と補足 / 操作」の 3 行。
 */
function ModelPanel({
  model,
  selectedModelId,
  selectedContextLength,
  cachedModelIds,
  unavailableModelIds,
  gpuDescription,
  translating,
  actions,
}: ModelPanelProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();

  const selected = getModel(selectedModelId);
  const cached = cachedModelIds.includes(selectedModelId);
  const unavailable = unavailableModelIds.includes(selectedModelId);
  const loading = model.kind === 'downloading' || model.kind === 'initializing';
  const blocked = model.kind === 'checking' || model.kind === 'unsupported';
  const busy = loading || translating;
  const loaded = model.kind === 'ready' && model.modelId === selectedModelId && model.contextLength === selectedContextLength;
  // 選択中の設定がまだ読み込まれていなければ、読み込みの操作を出す。
  const canLoad = (model.kind === 'idle' || model.kind === 'ready') && !loaded && !unavailable;
  // バーは選択中の設定を表す。別の設定が読み込まれているだけなら、選択中の設定は未ロード。
  const statusKind = model.kind === 'ready' && !loaded ? 'idle' : model.kind;
  // スマートフォン幅では、操作がないときにバーの 3 行目を出さない。
  const hasAction = loading || model.kind === 'failed' || canLoad;

  const settingsToggle = {
    open: settingsOpen,
    controls: settingsId,
    onToggle: () => setSettingsOpen(open => !open),
  };

  return (
    <section aria-label="モデル" className="flex flex-col gap-2">
      <div className="border-base-300 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-y px-1 py-2.5 md:min-h-14 md:grid-cols-[auto_auto_minmax(0,1fr)] md:gap-x-6 md:gap-y-0 md:py-2 xl:grid-cols-[auto_auto_auto_minmax(0,1fr)]">
        <span className="font-serif col-span-2 col-start-1 row-start-1 min-w-0 truncate font-semibold md:col-span-1 md:text-base">
          {selected.label}
        </span>
        {!blocked && (
          <button
            type="button"
            className="btn btn-ghost btn-square btn-sm col-start-3 row-start-1 -mr-1 justify-self-end md:hidden"
            aria-label="設定を変更"
            aria-expanded={settingsOpen}
            aria-controls={settingsId}
            onClick={settingsToggle.onToggle}
          >
            <Icon name="chevron-down" className={`size-5 transition-transform ${settingsOpen ? 'rotate-180' : ''}`} />
          </button>
        )}
        <span
          className="col-start-1 row-start-2 flex items-center gap-3 md:col-start-2 md:row-span-2 md:row-start-1 xl:col-start-3 xl:row-span-1 xl:gap-6"
          title={gpuDescription || undefined}
        >
          <ModelStatusBadge kind={statusKind} />
          {model.kind === 'ready' && loaded && (
            <span className="hidden text-sm whitespace-nowrap tabular-nums md:inline">読み込み {model.loadSeconds.toFixed(1)} 秒</span>
          )}
        </span>
        <span className="text-base-content/80 col-span-2 col-start-2 row-start-2 min-w-0 text-sm tabular-nums md:col-span-1 md:col-start-1 xl:col-start-2 xl:row-start-1">
          {selectedContextLength} トークン ・ {formatBytes(selected.sizeBytes)}
          {/* スマートフォン幅では省く。操作のボタンと案内で分かる。 */}
          <span className="hidden md:inline"> ・ {cached ? '保存済み' : '未ダウンロード'}</span>
        </span>
        <div
          className={`${hasAction ? 'flex' : 'hidden md:flex'} col-span-3 col-start-1 row-start-3 mt-2 md:col-span-1 md:col-start-3 md:row-span-2 md:row-start-1 md:mt-0 md:justify-end xl:col-start-4 xl:row-span-1`}
        >
          <ModelActions
            model={model}
            cached={cached}
            canLoad={canLoad}
            busy={busy}
            blocked={blocked}
            settingsToggle={settingsToggle}
            actions={actions}
          />
        </div>
      </div>

      <ModelSettings
        id={settingsId}
        open={settingsOpen}
        selected={selected}
        selectedContextLength={selectedContextLength}
        unavailableModelIds={unavailableModelIds}
        cached={cached}
        disabled={busy || blocked}
        busy={busy}
        actions={actions}
      />

      <ModelNotice model={model} cached={cached} canLoad={canLoad} unavailable={unavailable} />
    </section>
  );
}

export default memo(ModelPanel);
