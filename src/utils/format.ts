export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export function formatPercent(loaded: number, total: number): string {
  return `${total > 0 ? Math.floor((loaded / total) * 100) : 0}%`;
}

export const licenseUrl =(language: 'ja' | 'en'): string =>
  `${import.meta.env.BASE_URL}licenses/LICENSE-PLaMo.${language}.txt`;
