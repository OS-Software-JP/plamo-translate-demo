import type {EnvironmentResult} from '../protocol';

/** WebGPU を使えるかを確かめる。LiteRT-LM が使うものと同じ条件で GPU を選ぶ。 */
export async function checkEnvironment(): Promise<EnvironmentResult> {
  if (!isSecureContext) return {supported: false, reason: 'insecure-context'};
  if (!navigator.gpu) return {supported: false, reason: 'webgpu-unavailable'};
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) return {supported: false, reason: 'no-adapter'};
  // ソフトウェア実装の WebGPU は実質的に CPU で動くので使わない。
  if (adapter.info.isFallbackAdapter) return {supported: false, reason: 'software-adapter'};
  const {vendor, architecture, description} = adapter.info;
  return {
    supported: true,
    bufferLimitBytes: Math.min(adapter.limits.maxBufferSize, adapter.limits.maxStorageBufferBindingSize),
    gpuDescription: description || [vendor, architecture].filter(Boolean).join(' '),
  };
}
