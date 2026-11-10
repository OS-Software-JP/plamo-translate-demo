// モデルのダウンロードと OPFS への保存。
import type {CachedModel} from '../protocol';
import {WorkerError, errorMessage} from './workerError';

const PROGRESS_INTERVAL_MS = 100;

const isNamedError = (error: unknown, name: string): boolean => error instanceof DOMException && error.name === name;

async function findCachedFile(name: string, sizeBytes: number): Promise<File | null> {
  const root = await navigator.storage.getDirectory();
  try {
    const file = await (await root.getFileHandle(name)).getFile();
    return file.size === sizeBytes ? file : null;
  } catch (error) {
    if (isNamedError(error, 'NotFoundError')) return null;
    throw error;
  }
}

async function ensureCapacity(sizeBytes: number): Promise<void> {
  const {quota, usage} = await navigator.storage.estimate();
  if (quota !== undefined && usage !== undefined && quota - usage < sizeBytes) {
    throw new WorkerError('insufficient-storage', `need ${sizeBytes} bytes, available ${quota - usage} bytes`);
  }
}

function toDownloadError(error: unknown): unknown {
  if (error instanceof WorkerError) return error;
  if (isNamedError(error, 'AbortError')) return new WorkerError('download-cancelled', 'download cancelled');
  if (isNamedError(error, 'QuotaExceededError')) return new WorkerError('insufficient-storage', errorMessage(error));
  return new WorkerError('download-failed', errorMessage(error));
}

/** fetch のストリームを OPFS に保存する。バイト数が一致してから確定し、失敗時は何も残さない。 */
async function download(
  url: string,
  name: string,
  sizeBytes: number,
  signal: AbortSignal,
  onProgress: (loadedBytes: number) => void,
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, {create: true});
  const writable = await handle.createWritable();
  let loaded = 0;
  let lastReport = 0;
  try {
    const response = await fetch(url, {signal});
    if (!response.ok || !response.body) throw new WorkerError('download-failed', `HTTP ${response.status}`);
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        const now = performance.now();
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now;
          onProgress(loaded);
        }
        controller.enqueue(chunk);
      },
    });
    await response.body.pipeThrough(counter).pipeTo(writable, {signal, preventClose: true});
    if (loaded !== sizeBytes) throw new WorkerError('download-failed', `size mismatch: ${loaded} != ${sizeBytes}`);
    await writable.close();
    onProgress(loaded);
  } catch (error) {
    await writable.abort().catch(() => {});
    await root.removeEntry(name).catch(() => {});
    throw error;
  }
}

/**
 * キャッシュ済みのファイルを返す。なければダウンロードする。
 * 複数のタブが同じモデルを同時に取得しないよう、Web Locks で順番を待つ。
 */
export async function ensureModelFile(
  url: string,
  name: string,
  sizeBytes: number,
  signal: AbortSignal,
  onProgress: (loadedBytes: number) => void,
): Promise<{file: File; downloaded: boolean}> {
  const fetchIfNeeded = async () => {
    const cached = await findCachedFile(name, sizeBytes);
    if (cached) return {file: cached, downloaded: false};
    await ensureCapacity(sizeBytes);
    await download(url, name, sizeBytes, signal, onProgress);
    const file = await findCachedFile(name, sizeBytes);
    if (!file) throw new WorkerError('download-failed', 'saved file was not found');
    return {file, downloaded: true};
  };
  try {
    return await navigator.locks.request(`plamo-model:${name}`, {signal}, fetchIfNeeded);
  } catch (error) {
    throw toDownloadError(error);
  }
}

/** キャッシュ済みのモデルを返す。モデル定義にない古いファイルは削除する。 */
export async function listCachedModels(validFileNames: string[]): Promise<CachedModel[]> {
  const root = await navigator.storage.getDirectory();
  const models: CachedModel[] = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'file') continue;
    if (validFileNames.includes(name)) {
      models.push({fileName: name, sizeBytes: (await (handle as FileSystemFileHandle).getFile()).size});
    } else if (name.endsWith('.litertlm')) {
      await root.removeEntry(name).catch(() => {});
    }
  }
  return models;
}

export async function deleteCachedModel(name: string): Promise<boolean> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(name);
    return true;
  } catch (error) {
    if (isNamedError(error, 'NotFoundError')) return false;
    throw error;
  }
}
