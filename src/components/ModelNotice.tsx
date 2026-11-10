import {BUFFER_LIMIT_ERROR} from '../inference/errors';
import type {ModelState} from '../inference/translatorStore';
import {licenseUrl} from '../utils/format';
import ErrorAlert from './ErrorAlert';

interface ModelNoticeProps {
  model: ModelState;
  cached: boolean;
  /** 選択中の設定がまだ読み込まれていない。 */
  canLoad: boolean;
  /** 選択中のモデルはこの GPU で動かせない。 */
  unavailable: boolean;
}

/** モデルのバーの下に出す、状態の説明とエラー。 */
export default function ModelNotice({model, cached, canLoad, unavailable}: ModelNoticeProps) {
  switch (model.kind) {
    case 'checking':
      return <p className="text-base-content/80 text-sm">WebGPU を確認しています。</p>;
    case 'unsupported':
    case 'failed':
      return <ErrorAlert error={model.error} />;
    case 'downloading':
      return <p className="text-sm">モデルをこのブラウザに保存しています。次回からは必要ありません。</p>;
    case 'initializing':
      return <p className="text-sm">前の処理が GPU に残っていると、時間がかかることがあります。</p>;
    case 'idle':
    case 'ready':
      break;
  }

  if (unavailable) return <ErrorAlert error={BUFFER_LIMIT_ERROR} />;
  if (!canLoad) return null;
  if (!cached) {
    return (
      <p className="text-sm">
        初回だけダウンロードが必要です。次回からはこのブラウザに保存したモデルを使います。モデルには{' '}
        <a className="link link-primary" href={licenseUrl('ja')} target="_blank" rel="noreferrer">
          PLaMo コミュニティライセンス
        </a>{' '}
        が適用されます。
      </p>
    );
  }
  if (model.kind === 'ready') {
    return <p className="text-sm">選択中の設定はまだ読み込んでいません。読み込むか、翻訳を始めると切り替わります。</p>;
  }
  return <p className="text-sm">翻訳を始めると、読み込んでから翻訳します。</p>;
}
