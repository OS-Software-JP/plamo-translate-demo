// モデルのファイルに口調の行 (config/tones.ts) を差し込む。保存したファイルは書き換えず、
// 該当の行だけを置き換えた Blob を SDK に渡す (Blob は元のファイルの一部を参照するだけで、複製しない)。
import {CHECK_TOKEN_ID, TONES, type ToneRows} from '../../config/tones';

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 口調の行を差し込んだ Blob を返す。ファイルが想定と違う (「ja」の行が一致しない) ときは null を返し、
 * 口調は使えないものとする。違う位置に書き込んで訳を壊さないため。
 */
export async function withToneRows(file: Blob, rows: ToneRows): Promise<Blob | null> {
  const check = rows.embeddingOffset + CHECK_TOKEN_ID * rows.rowBytes;
  const digest = await sha256Hex(await file.slice(check, check + rows.rowBytes).arrayBuffer());
  if (digest !== rows.checkRowSha256) return null;

  const patches = TONES.map(tone => ({
    offset: rows.embeddingOffset + tone.tokenId * rows.rowBytes,
    bytes: fromBase64(rows.rows[tone.id]),
  })).sort((a, b) => a.offset - b.offset);
  const parts: BlobPart[] = [];
  let position = 0;
  for (const {offset, bytes} of patches) {
    if (bytes.length !== rows.rowBytes) throw new Error(`tone row has ${bytes.length} bytes, expected ${rows.rowBytes}`);
    parts.push(file.slice(position, offset), bytes);
    position = offset + bytes.length;
  }
  parts.push(file.slice(position));
  const patched = new Blob(parts);
  if (patched.size !== file.size) throw new Error(`patched model has ${patched.size} bytes, expected ${file.size}`);
  return patched;
}
