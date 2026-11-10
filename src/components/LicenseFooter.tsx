import {memo} from 'react';
import {licenseUrl} from '../utils/format';

/** gpuName は使っている GPU の名前 (環境の確認で分かる)。空なら出さない。 */
function LicenseFooter({gpuName}: {gpuName: string}) {
  return (
    <footer className="border-base-300 flex flex-col items-center gap-2 text-center text-sm md:flex-row md:gap-6 md:text-left">
      <strong className="whitespace-nowrap">Built with PLaMo</strong>
      {/* 生成物である旨 (ライセンス第 5 条)。モデル名の途中では改行しない。 */}
      <p className="text-balance md:border-base-300 md:flex-1 md:border-x md:px-6 md:text-wrap">
        翻訳結果は <span className="whitespace-nowrap">PLaMo 3 Translate (LiteRT-LM 版)</span> の生成物です。
      </p>
      {gpuName && <p className="md:border-base-300 whitespace-nowrap md:border-r md:pr-6">GPU: {gpuName}</p>}
      <p className="whitespace-nowrap">
        ライセンス:{' '}
        <a className="link" href={licenseUrl('ja')} target="_blank" rel="noreferrer">
          日本語
        </a>{' '}
        /{' '}
        <a className="link" href={licenseUrl('en')} target="_blank" rel="noreferrer">
          English
        </a>
      </p>
    </footer>
  );
}

export default memo(LicenseFooter);
