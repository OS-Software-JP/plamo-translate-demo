import type {ModelState} from '../inference/translatorStore';

const LABELS: Record<ModelState['kind'], string> = {
  checking: '確認中',
  unsupported: '非対応',
  idle: '未ロード',
  downloading: 'ダウンロード中',
  initializing: '初期化中',
  ready: '準備完了',
  failed: 'エラー',
};

const STYLES: Record<ModelState['kind'], string> = {
  checking: 'bg-base-300/40 border-transparent text-base-content',
  unsupported: 'badge-error',
  idle: 'bg-base-300/40 border-transparent text-base-content',
  downloading: 'badge-primary',
  initializing: 'badge-primary',
  ready: 'badge-primary',
  failed: 'badge-error',
};

export default function ModelStatusBadge({kind}: {kind: ModelState['kind']}) {
  return <span className={`badge shrink-0 font-semibold whitespace-nowrap ${STYLES[kind]}`}>{LABELS[kind]}</span>;
}
