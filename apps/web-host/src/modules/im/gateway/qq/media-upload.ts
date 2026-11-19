import { createHash } from 'node:crypto';
import type { ProviderHttpResponse, ProviderTransport } from '@gugu/core/providers';
import { asciiDecimalDigits, isDecimalDigits } from '@gugu/core/shared/unicode-decimal';
import { QqApiError } from './client.js';
import type { createQqClient } from './client.js';

export const QQ_ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024;
const prefixBytes = 10_002_432;
type Stage = 'input' | 'prepare' | 'part' | 'finish' | 'complete' | 'close';
export class QqMediaUploadError extends Error {
  constructor(readonly stage: Stage, readonly outcome: 'UNKNOWN' | 'FAILED_CONFIRMED', readonly statusCode?: number) { super('QQ 媒体上传失败'); this.name = 'QqMediaUploadError'; }
}
function error(stage: Stage, value: unknown): QqMediaUploadError {
  if (value instanceof QqMediaUploadError) return value;
  if (value instanceof QqApiError) return new QqMediaUploadError(stage, value.outcome, value.statusCode);
  return new QqMediaUploadError(stage, 'UNKNOWN');
}
function positive(value: unknown): number | undefined {
  const number = typeof value === 'string' && isDecimalDigits(value) ? Number(asciiDecimalDigits(value)) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('hex');
export interface QqMediaUploadInput { target: 'users' | 'groups'; openid: string; fileType: 1 | 2 | 3 | 4; data: Uint8Array; fileName: string; signal?: AbortSignal; authorize?(): Promise<boolean> }

/** QQ分块媒体准备，不发送消息；file_info成功也不是消息投递回执。 */
export function createQqMediaUploader(options: { client: Pick<ReturnType<typeof createQqClient>, 'call'>; transport?: ProviderTransport; timeoutMs?: number }) {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new QqMediaUploadError('input', 'FAILED_CONFIRMED');
  const lifetime = new AbortController(); const tasks = new Set<Promise<Record<string, unknown>>>();
  let transport = options.transport, opening: Promise<ProviderTransport> | undefined;
  async function run(input: QqMediaUploadInput): Promise<Record<string, unknown>> {
    if (!['users', 'groups'].includes(input.target) || !/^[A-Za-z0-9_-]{1,256}$/.test(input.openid) || ![1, 2, 3, 4].includes(input.fileType) || !(input.data instanceof Uint8Array) || !input.data.byteLength || input.data.byteLength > QQ_ATTACHMENT_MAX_BYTES || !input.fileName || /[\r\n\0]/.test(input.fileName)) throw new QqMediaUploadError('input', 'FAILED_CONFIRMED');
    // 固定本次上传快照；调用方改变原数组不能破坏hash与分块内容一致性。
    const data = Buffer.from(input.data);
    const work = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, work.signal, ...(input.signal ? [input.signal] : [])]);
    const timer = setTimeout(() => work.abort(), timeoutMs);
    const path = `/v2/${input.target}/${input.openid}`;
    let stage: Stage = 'prepare';
    try {
      signal.throwIfAborted();
      if (input.authorize && !await input.authorize()) throw new QqMediaUploadError('input', 'FAILED_CONFIRMED');
      const prepare = await options.client.call('POST', path + '/upload_prepare', { signal, timeoutMs, authorize: input.authorize, body: { file_type: input.fileType, file_name: input.fileName, file_size: data.byteLength, md5: hash('md5', data), sha1: hash('sha1', data), md5_10m: hash('md5', data.subarray(0, prefixBytes)) } });
      const blockSize = positive(prepare.block_size);
      if (typeof prepare.upload_id !== 'string' || !prepare.upload_id || !blockSize || !Array.isArray(prepare.parts) || !prepare.parts.length || prepare.parts.length !== Math.ceil(data.byteLength / blockSize)) throw new QqMediaUploadError('prepare', 'FAILED_CONFIRMED');
      const uploadId = prepare.upload_id;
      const parts: { index: number; url: string; bytes: Buffer }[] = [];
      const seen = new Set<number>();
      for (const part of prepare.parts) {
        if (!object(part) || typeof part.index !== 'number' || !Number.isSafeInteger(part.index) || part.index < 1 || part.index > prepare.parts.length || seen.has(part.index) || typeof part.presigned_url !== 'string') throw new QqMediaUploadError('prepare', 'FAILED_CONFIRMED');
        seen.add(part.index);
        const endpoint = new URL(part.presigned_url);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.port && endpoint.port !== '443' || !(endpoint.hostname === 'myqcloud.com' || endpoint.hostname.endsWith('.myqcloud.com'))) throw new QqMediaUploadError('prepare', 'FAILED_CONFIRMED');
        const offset = (part.index - 1) * blockSize, bytes = data.subarray(offset, offset + blockSize);
        const advertised = part.block_size === undefined ? undefined : positive(part.block_size);
        if (!bytes.byteLength || part.block_size !== undefined && advertised !== blockSize && advertised !== bytes.byteLength) throw new QqMediaUploadError('prepare', 'FAILED_CONFIRMED');
        parts.push({ index: part.index, url: part.presigned_url, bytes });
      }
      // 不改写预签名query；底层ProviderTransport继续负责公共URL策略与DNS固定。
      if (!transport) { opening ??= import('@gugu/core/providers/node').then(({ NodeProviderTransport }) => new NodeProviderTransport({ trustEnvironment: false })); transport = await opening; }
      const advertised = object(prepare.upload_config) ? prepare.upload_config.concurrency : prepare.concurrency;
      const concurrency = typeof advertised === 'number' && Number.isSafeInteger(advertised) && advertised > 0 ? Math.min(advertised, 10) : 1;
      let next = 0;
      let firstError: QqMediaUploadError | undefined;
      stage = 'part';
      const worker = async () => {
        while (!signal.aborted) {
          const part = parts[next++]; if (!part) return;
          let response: ProviderHttpResponse | undefined;
          const cancel = () => { void (async () => { try { await response?.cancel(); } catch { /* 禁止传播预签名URL及底层错误。 */ } })(); };
          let partStage: Stage = 'part';
          signal.addEventListener('abort', cancel, { once: true });
          try {
            signal.throwIfAborted();
            if (input.authorize && !await input.authorize()) throw new QqMediaUploadError('part', 'FAILED_CONFIRMED');
            response = await transport!.request({ method: 'PUT', url: part.url, headers: { 'content-type': 'application/octet-stream' }, body: part.bytes, timeoutMs }, signal);
            signal.throwIfAborted();
            if (response.status < 200 || response.status >= 300) throw new QqMediaUploadError('part', response.status >= 400 && response.status < 500 && response.status !== 408 ? 'FAILED_CONFIRMED' : 'UNKNOWN', response.status);
            // COS PUT成功不读取可能回显敏感字段的响应正文，取消以释放连接。
            await response.cancel(); response = undefined;
            partStage = 'finish';
            if (input.authorize && !await input.authorize()) throw new QqMediaUploadError('finish', 'FAILED_CONFIRMED');
            await options.client.call('POST', path + '/upload_part_finish', { signal, timeoutMs, authorize: input.authorize, body: { upload_id: uploadId, part_index: part.index, block_size: part.bytes.byteLength, md5: hash('md5', part.bytes) } });
          } catch (value) { firstError ??= error(partStage, value); work.abort(); return; }
          finally { signal.removeEventListener('abort', cancel); try { await response?.cancel(); } catch { /* 不暴露原始网络异常。 */ } }
        }
      };
      await Promise.allSettled(Array.from({ length: Math.min(concurrency, parts.length) }, worker));
      if (firstError) throw firstError;
      signal.throwIfAborted();
      stage = 'complete';
      if (input.authorize && !await input.authorize()) throw new QqMediaUploadError('complete', 'FAILED_CONFIRMED');
      const complete = await options.client.call('POST', path + '/files', { signal, timeoutMs, authorize: input.authorize, body: { upload_id: uploadId } });
      if (typeof complete.file_info !== 'string' || !complete.file_info) throw new QqMediaUploadError('complete', 'UNKNOWN');
      return complete;
    } catch (value) { throw error(stage, value); }
    finally { clearTimeout(timer); work.abort(); }
  }
  return {
    upload(input: QqMediaUploadInput) {
      const task = run(input); tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); return task;
    },
    async close() {
      lifetime.abort(); await Promise.allSettled([...tasks]);
      try { if (!transport && opening) transport = await opening; await transport?.close?.(); } catch { throw new QqMediaUploadError('close', 'UNKNOWN'); }
    },
  };
}
