import type {TranslatorActions} from '../hooks/useTranslator';
import type {ModelState} from '../inference/translatorStore';
import {formatBytes, formatPercent} from '../utils/format';
import Icon from './Icon';
import Spinner from './Spinner';

interface ModelActionsProps {
  model: ModelState;
  cached: boolean;
  /** 選択中の設定がまだ読み込まれていない。 */
  canLoad: boolean;
  busy: boolean;
  /** 環境の確認中か非対応。操作を出さない。 */
  blocked: boolean;
  settingsToggle: {open: boolean; controls: string; onToggle: () => void};
  actions: TranslatorActions;
}

/** モデルのバーの右側に置く、状態に応じた操作。ダウンロード中は進捗を出す。 */
export default function ModelActions({model, cached, canLoad, busy, blocked, settingsToggle, actions}: ModelActionsProps) {
  if (model.kind === 'downloading') {
    return (
      <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 md:flex-nowrap">
        <progress
          className="progress progress-primary h-3 min-w-40 flex-1"
          value={model.loadedBytes}
          max={model.totalBytes}
          aria-label="モデルのダウンロードの進捗"
        />
        <span className="text-sm whitespace-nowrap tabular-nums">
          {formatBytes(model.loadedBytes)} / {formatBytes(model.totalBytes)} ({formatPercent(model.loadedBytes, model.totalBytes)})
        </span>
        <button type="button" className="btn border-base-300 bg-base-100 hover:bg-base-200" onClick={actions.cancelDownload}>
          中止
        </button>
      </div>
    );
  }
  if (model.kind === 'initializing') {
    return (
      <p className="flex items-center gap-2 text-sm">
        <Spinner />
        GPU にモデルを読み込んでいます
      </p>
    );
  }
  if (blocked) return null;

  const primary = 'btn btn-primary w-full text-base font-bold md:w-auto md:px-6';
  return (
    <div className="flex w-full items-center gap-2 md:w-auto md:gap-5">
      {/* スマートフォン幅では、バーの右上の開閉ボタンを使う。 */}
      <button
        type="button"
        className="link hidden items-center gap-1 text-sm underline-offset-4 md:inline-flex"
        aria-expanded={settingsToggle.open}
        aria-controls={settingsToggle.controls}
        onClick={settingsToggle.onToggle}
      >
        設定を変更
        <Icon name="chevron-down" className={`size-4 transition-transform ${settingsToggle.open ? 'rotate-180' : ''}`} />
      </button>
      {model.kind === 'failed' && (
        <button type="button" className={primary} onClick={actions.dismissFailure}>
          やり直す
        </button>
      )}
      {canLoad && (
        <button type="button" className={primary} disabled={busy} onClick={() => void actions.load()}>
          {cached ? '読み込む' : 'ダウンロードして読み込む'}
        </button>
      )}
    </div>
  );
}
