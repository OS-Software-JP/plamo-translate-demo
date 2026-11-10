import type {ReactNode} from 'react';
import Icon, {type IconName} from './Icon';

const formatInteger = new Intl.NumberFormat('ja-JP');

/** 3 桁以上は小数 1 桁、それ未満は小数 2 桁にする (307.7、56.21)。 */
function formatDecimal(value: number): string {
  const digits = value >= 100 ? 1 : 2;
  return value.toLocaleString('ja-JP', {minimumFractionDigits: digits, maximumFractionDigits: digits});
}

function Item({icon, title, children}: {icon: IconName; title: string; children: ReactNode}) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={title}>
      <Icon name={icon} className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

/** 原文の処理や訳文の生成の計測値。分からない値は省く (最初の出力の前の秒数など)。 */
export interface PhaseValues {
  tokens?: number;
  /** トークン数の上限。指定すると「トークン数 / 上限」の形にする。 */
  limit?: number;
  seconds?: number;
  tokensPerSecond?: number;
}

interface PhaseMetricsProps extends PhaseValues {
  /** 何の計測値か。支援技術に伝える。 */
  label: string;
  /** 秒数が何の時間か。マウスを乗せたときに表示する。 */
  secondsTitle?: string;
  className?: string;
}

/** llama-server の WebUI のように、トークン数、時間、速度をアイコンつきで並べる。 */
export default function PhaseMetrics({
  label,
  secondsTitle = '時間',
  tokens,
  limit,
  seconds,
  tokensPerSecond,
  className = '',
}: PhaseMetricsProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`text-base-content/70 flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-sm tabular-nums ${className}`}
    >
      {tokens !== undefined && (
        <Item icon="tokens" title="トークン数">
          {formatInteger.format(tokens)}
          {/* 上限が数値でないとき (計算に必要な値が欠けたとき) は、NaN を出さずに省く。 */}
          {limit === undefined || !Number.isFinite(limit) ? '' : ` / ${formatInteger.format(limit)}`} tokens
        </Item>
      )}
      {seconds !== undefined && (
        <Item icon="clock" title={secondsTitle}>
          {formatDecimal(seconds)}s
        </Item>
      )}
      {tokensPerSecond !== undefined && (
        <Item icon="gauge" title="速度">
          {formatDecimal(tokensPerSecond)} t/s
        </Item>
      )}
    </div>
  );
}
