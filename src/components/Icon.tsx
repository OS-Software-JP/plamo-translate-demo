const PATHS = {
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  swap: 'M7 8h13m0 0-4-4m4 4-4 4M17 16H4m0 0 4-4m-4 4 4 4',
  copy: 'M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1',
  check: 'M4 12.5 9.5 18 20 6.5',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-right': 'm9 6 6 6-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  stop: 'M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  // 計測値の表示に使う。トークン数、時間、速度。
  tokens: 'M10 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM10 9v6M20 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM14 7v8M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  gauge: 'm12 14 4-4M3.34 19a10 10 0 1 1 17.32 0',
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({name, className = 'size-5'}: {name: IconName; className?: string}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
