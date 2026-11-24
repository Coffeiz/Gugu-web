import { createHash } from 'node:crypto';
import { asciiDecimalDigits, isDecimalDigits } from '@gugu/core/shared/unicode-decimal';
import { QqApiError } from './client.js';
export const QQ_ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024;
const prefixBytes = 10_002_432;
export class QqMediaUploadError extends Error {
    stage;
    outcome;
    statusCode;
    errorCode;
    constructor(stage, outcome, statusCode, errorCode) {
        super('QQ 媒体上传失败');
        this.stage = stage;
        this.outcome = outcome;
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.name = 'QqMediaUploadError';
    }
}
function error(stage, value) {
    if (value instanceof QqMediaUploadError)
        return value;
    if (value instanceof QqApiError)
        return new QqMediaUploadError(stage, value.outcome, value.statusCode, value.errorCode);
    return new QqMediaUploadError(stage, 'UNKNOWN');
}
function positive(value) {
    const number = typeof value === 'string' && isDecimalDigits(value) ? Number(asciiDecimalDigits(value)) : value;
    return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
/** QQ分块媒体准备，不发送消息；file_info成功也不是消息投递回执。 */
export function createQqMediaUploader(options) {
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)
        throw new QqMediaUploadError('input', 'FAILED_CONFIRMED');
    const lifetime = new AbortController();
    const tasks = new Set();
    let transport = options.transport, opening;
    async function run(input) {
        if (!['users', 'groups'].includes(input.target) || !/^[A-Za-z0-9_-]{1,256}$/.test(input.openid) || ![1, 2, 3, 4].includes(input.fileType) || !(input.data instanceof Uint8Array) || !input.data.byteLength || input.data.byteLength > QQ_ATTACHMENT_MAX_BYTES || !input.fileName || /[\r\n\0]/.test(input.fileName))
            throw new QqMediaUploadError('input', 'FAILED_CONFIRMED');
        // 固定本次上传快照；调用方改变原数组不能破坏hash与分块内容一致性。
        const started = performance.now();
        const metrics = { prepareMs: 0, transferMs: 0, putMs: 0, finishMs: 0, completeMs: 0, parts: 0, concurrency: 0, elapsedMs: 0 };
        const data = Buffer.from(input.data);
        const work = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, work.signal, ...(input.signal ? [input.signal] : [])]);
        const timer = setTimeout(() => work.abort(), timeoutMs);
        const path = `/v2/${input.target}/${input.openid}`;
        let stage = 'prepare';
        try {
            signal.throwIfAborted();
            if (input.authorize && !await input.authorize())
                throw new QqMediaUploadError('input', 'FAILED_CONFIRMED');
            const prepare = await options.client.call('POST', path + '/upload_prepare', { signal, timeoutMs, authorize: input.authorize, body: { file_type: input.fileType, file_name: input.fileName, file_size: data.byteLength, md5: hash('md5', data), sha1: hash('sha1', data), md5_10m: hash('md5', data.subarray(0, prefixBytes)) } });
            metrics.prepareMs = Math.round(performance.now() - started);
            const blockSize = positive(prepare.block_size);
            if (typeof prepare.upload_id !== 'string' || !prepare.upload_id || !blockSize || !Array.isArray(prepare.parts) || !prepare.parts.length || prepare.parts.length !== Math.ceil(data.byteLength / blockSize))
                throw new QqMediaUploadError('prepare', 'FAILED_CONFIRMED');
            const uploadId = prepare.upload_id;
            const parts = [];
            const seen = new Set();
            for (const part of prepare.parts) {
                if (!object(part) || typeof part.index !== 'number' || !Number.isSafeInteger(part.index) || part.index < 1 || part.index > prepare.parts.length || seen.has(part.index) || typeof part.presigned_url !== 'string')
                    throw new QqMediaUploadError('prepare', 'FAILED_CONFIRMED');
                seen.add(part.index);
                const endpoint = new URL(part.presigned_url);
                if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.port && endpoint.port !== '443' || !(endpoint.hostname === 'myqcloud.com' || endpoint.hostname.endsWith('.myqcloud.com')))
                    throw new QqMediaUploadError('prepare', 'FAILED_CONFIRMED');
                const offset = (part.index - 1) * blockSize, bytes = data.subarray(offset, offset + blockSize);
                const advertised = part.block_size === undefined ? undefined : positive(part.block_size);
                if (!bytes.byteLength || part.block_size !== undefined && advertised !== blockSize && advertised !== bytes.byteLength)
                    throw new QqMediaUploadError('prepare', 'FAILED_CONFIRMED');
                parts.push({ index: part.index, url: part.presigned_url, bytes });
            }
            // 不改写预签名query；底层ProviderTransport继续负责公共URL策略与DNS固定。
            if (!transport) {
                opening ??= import('@gugu/core/providers/node').then(({ NodeProviderTransport }) => new NodeProviderTransport({ trustEnvironment: false }));
                transport = await opening;
            }
            const advertised = object(prepare.upload_config) ? prepare.upload_config.concurrency : prepare.concurrency;
            const concurrency = typeof advertised === 'number' && Number.isSafeInteger(advertised) && advertised > 0 ? Math.min(advertised, input.partConcurrencyLimit ?? 10) : 1;
            metrics.parts = parts.length;
            metrics.concurrency = Math.min(concurrency, parts.length);
            const transferStarted = performance.now();
            let next = 0;
            let firstError;
            stage = 'part';
            const worker = async () => {
                while (!signal.aborted) {
                    const part = parts[next++];
                    if (!part)
                        return;
                    let response;
                    const cancel = () => { void (async () => { try {
                        await response?.cancel();
                    }
                    catch { /* 禁止传播预签名URL及底层错误。 */ } })(); };
                    let partStage = 'part';
                    signal.addEventListener('abort', cancel, { once: true });
                    try {
                        signal.throwIfAborted();
                        if (input.authorize && !await input.authorize())
                            throw new QqMediaUploadError('part', 'FAILED_CONFIRMED');
                        const putStarted = performance.now();
                        response = await transport.request({ method: 'PUT', url: part.url, headers: { 'content-type': 'application/octet-stream' }, body: part.bytes, timeoutMs }, signal);
                        metrics.putMs += Math.round(performance.now() - putStarted);
                        signal.throwIfAborted();
                        if (response.status < 200 || response.status >= 300)
                            throw new QqMediaUploadError('part', response.status >= 400 && response.status < 500 && response.status !== 408 ? 'FAILED_CONFIRMED' : 'UNKNOWN', response.status);
                        // COS PUT成功不读取可能回显敏感字段的响应正文，取消以释放连接。
                        await response.cancel();
                        response = undefined;
                        partStage = 'finish';
                        // QQ 客户端紧贴实际请求复核，避免重复读取同一授权。
                        const finishStarted = performance.now();
                        await options.client.call('POST', path + '/upload_part_finish', { signal, timeoutMs, authorize: input.authorize, body: { upload_id: uploadId, part_index: part.index, block_size: part.bytes.byteLength, md5: hash('md5', part.bytes) } });
                        metrics.finishMs += Math.round(performance.now() - finishStarted);
                    }
                    catch (value) {
                        firstError ??= error(partStage, value);
                        work.abort();
                        return;
                    }
                    finally {
                        signal.removeEventListener('abort', cancel);
                        try {
                            await response?.cancel();
                        }
                        catch { /* 不暴露原始网络异常。 */ }
                    }
                }
            };
            await Promise.allSettled(Array.from({ length: metrics.concurrency }, worker));
            metrics.transferMs = Math.round(performance.now() - transferStarted);
            if (firstError)
                throw firstError;
            signal.throwIfAborted();
            stage = 'complete';
            const completeStarted = performance.now();
            const complete = await options.client.call('POST', path + '/files', { signal, timeoutMs, authorize: input.authorize, body: { upload_id: uploadId } });
            metrics.completeMs = Math.round(performance.now() - completeStarted);
            if (typeof complete.file_info !== 'string' || !complete.file_info)
                throw new QqMediaUploadError('complete', 'UNKNOWN');
            return complete;
        }
        catch (value) {
            throw error(stage, value);
        }
        finally {
            clearTimeout(timer);
            work.abort();
            metrics.elapsedMs = Math.round(performance.now() - started);
            try {
                options.observe?.(metrics);
            }
            catch { /* 诊断失败不影响投递结果。 */ }
        }
    }
    return {
        upload(input) {
            const task = run(input);
            tasks.add(task);
            void task.then(() => tasks.delete(task), () => tasks.delete(task));
            return task;
        },
        async close() {
            lifetime.abort();
            await Promise.allSettled([...tasks]);
            try {
                if (!transport && opening)
                    transport = await opening;
                await transport?.close?.();
            }
            catch {
                throw new QqMediaUploadError('close', 'UNKNOWN');
            }
        },
    };
}
