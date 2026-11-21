import { createImMediaBudget } from '../../runtime/media-budget.js';
import { ProviderError } from '@gugu/core/providers';
import { aesEcbPaddedSize, aeskeyToB64, aeskeyToHex, decryptInboundAesEcb, encryptForUpload, genFilekeyHex, md5Hex } from './media-crypto.js';
export const WECHAT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const cdnOrigin = 'https://novac2c.cdn.weixin.qq.com';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** 只保留固定操作/结果类别；不持有URL、AES材料、正文、文件名或CDN响应。 */
export class WechatMediaError extends Error {
    operation;
    outcome;
    statusCode;
    constructor(operation, outcome, statusCode) {
        super('微信媒体传输未完成');
        this.operation = operation;
        this.outcome = outcome;
        this.statusCode = statusCode;
        this.name = 'WechatMediaError';
    }
}
function invalid(operation) { throw new WechatMediaError(operation, 'rejected'); }
function secretString(value, operation) {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value))
        return invalid(operation);
    return value;
}
/** 仅当前已知官方CDN路径；不能借平台返回URL扩大Host出网白名单。 */
export function validateWechatCdnUrl(raw, operation) {
    try {
        if (typeof raw !== 'string' || raw.length > 16384 || /[\x00-\x20\x7f\\]/.test(raw))
            return invalid(operation);
        const url = new URL(raw);
        if (url.origin !== cdnOrigin || url.username || url.password || url.port || url.hash || url.pathname !== `/c2c/${operation}`)
            return invalid(operation);
        // 与公共连接校验一致；不通过改名或绕过校验兼容未知的凭据URL。
        if ([...url.searchParams.keys()].some(name => /^(api[_-]?key|token|access_token|secret|authorization)$/i.test(name)))
            return invalid(operation);
        return url.href;
    }
    catch {
        return invalid(operation);
    }
}
function header(response, name) {
    return Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}
function imageType(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return { ext: 'png', mime: 'image/png' };
    if (bytes.subarray(0, 4).toString('ascii') === 'GIF8')
        return { ext: 'gif', mime: 'image/gif' };
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
        return { ext: 'webp', mime: 'image/webp' };
    return { ext: 'jpg', mime: 'image/jpeg' };
}
export function createWechatMedia(options) {
    const maxBytes = options.maxBytes ?? WECHAT_MEDIA_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > WECHAT_MEDIA_MAX_BYTES)
        return invalid('configure');
    let transport = options.transport;
    let opening;
    let closed = false;
    const closing = new AbortController();
    async function network() {
        if (closed)
            return invalid('configure');
        if (!transport) {
            opening ??= import('@gugu/core/providers/node').then(({ NodeProviderTransport }) => new NodeProviderTransport());
            transport = await opening;
        }
        if (closed)
            return invalid('configure');
        return transport;
    }
    /** 所有响应均由默认transport执行DNS固定、公共地址和代理校验，不提供allowLocal。 */
    async function request(operation, input, use, signal, authorize) {
        let response;
        const timeout = new AbortController();
        const combined = AbortSignal.any([closing.signal, timeout.signal, ...(signal ? [signal] : [])]);
        const timer = setTimeout(() => timeout.abort(), 30_000);
        const cancel = () => { void (async () => { try {
            await response?.cancel();
        }
        catch { /* 清理不公开平台错误。 */ } })(); };
        combined.addEventListener('abort', cancel, { once: true });
        try {
            combined.throwIfAborted();
            const activeTransport = await network();
            if (authorize && await authorize() !== true)
                throw new WechatMediaError(operation, 'rejected', 403);
            combined.throwIfAborted();
            response = await activeTransport.request(input, combined);
            combined.throwIfAborted();
            return await use(response, combined);
        }
        catch (error) {
            if (error instanceof WechatMediaError || error instanceof ProviderError)
                throw error;
            throw new WechatMediaError(operation, 'unknown', response?.status);
        }
        finally {
            clearTimeout(timer);
            combined.removeEventListener('abort', cancel);
            try {
                await response?.cancel();
            }
            catch { /* 不公开异常。 */ }
        }
    }
    async function downloadImage(item, signal, authorize) {
        if (!object(item) || !object(item.image_item) || !Object.keys(item.image_item).length)
            return null;
        const image = item.image_item, media = object(image.media) ? image.media : {};
        if (!image.aeskey || (!media.full_url && !media.encrypt_query_param))
            return null;
        if (typeof image.aeskey !== 'string' || !/^(?:[a-f0-9]{2}[ \t\n\r\v\f]*){16}$/i.test(image.aeskey.trim()))
            return invalid('download');
        const key = Buffer.from(image.aeskey.replace(/[ \t\n\r\v\f]/g, ''), 'hex');
        const rawUrl = media.full_url ? secretString(media.full_url, 'download') : `${cdnOrigin}/c2c/download?encrypted_query_param=${encodeURIComponent(secretString(media.encrypt_query_param, 'download'))}`;
        const url = validateWechatCdnUrl(rawUrl, 'download');
        try {
            const ciphertext = await request('download', { url, method: 'GET', headers: {}, timeoutMs: 30_000 }, async (response, combined) => {
                if (response.status < 200 || response.status >= 300)
                    throw new WechatMediaError('download', response.status < 500 ? 'rejected' : 'unknown', response.status);
                const limit = aesEcbPaddedSize(maxBytes);
                const declared = header(response, 'content-length');
                if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit))
                    return invalid('download');
                const chunks = [];
                let size = 0;
                for await (const chunk of response.body) {
                    combined.throwIfAborted();
                    size += chunk.byteLength;
                    if (size > limit)
                        return invalid('download');
                    chunks.push(chunk);
                }
                combined.throwIfAborted();
                return Buffer.concat(chunks);
            }, signal, authorize);
            const bytes = decryptInboundAesEcb(ciphertext, key);
            if (!bytes.length || bytes.length > maxBytes)
                return invalid('download');
            return { bytes, ...imageType(bytes) };
        }
        catch (error) {
            if (error instanceof WechatMediaError)
                throw error;
            throw new WechatMediaError('download', 'unknown');
        }
    }
    async function prepareItem(input, signal) {
        if (!(input.data instanceof Uint8Array) || input.data.byteLength > maxBytes || !input.toUserId || /[\x00-\x1f\x7f]/.test(input.toUserId) || !['image', 'file'].includes(input.kind))
            return invalid('upload');
        if (input.kind === 'file' && (typeof input.fileName !== 'string' || !input.fileName || input.fileName.length > 255 || /[\x00-\x1f\x7f]/.test(input.fileName)))
            return invalid('upload');
        try {
            if (closed || signal?.aborted)
                return invalid('upload');
            const combined = AbortSignal.any([closing.signal, ...(signal ? [signal] : [])]);
            // 一次上传的filekey、AES和密文只生成一次，重试保持完全相同。
            const plaintext = Buffer.from(input.data), encrypted = encryptForUpload(plaintext), filekey = genFilekeyHex();
            const response = await options.client.getUploadUrl({ filekey, aeskey: aeskeyToHex(encrypted.aeskey), media_type: input.kind === 'image' ? 1 : 3,
                to_user_id: input.toUserId, rawsize: plaintext.byteLength, rawfilemd5: md5Hex(plaintext), filesize: encrypted.paddedSize, no_need_thumb: true }, combined, input.authorize);
            const fullUrl = typeof response.upload_full_url === 'string' ? response.upload_full_url.trim() : response.upload_full_url;
            const rawUrl = fullUrl ? secretString(fullUrl, 'upload') : `${cdnOrigin}/c2c/upload?encrypted_query_param=${encodeURIComponent(secretString(response.upload_param, 'upload'))}&filekey=${filekey}`;
            const url = validateWechatCdnUrl(rawUrl, 'upload');
            let downloadParam = '';
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    downloadParam = await request('upload', { url, method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted.ciphertext, timeoutMs: 30_000 }, async (cdn) => {
                        if (cdn.status < 200 || cdn.status >= 300)
                            throw new WechatMediaError('upload', cdn.status >= 500 ? 'unknown' : 'rejected', cdn.status);
                        return secretString(header(cdn, 'x-encrypted-param'), 'upload');
                    }, signal, input.authorize);
                    break;
                }
                catch (error) {
                    const retryable = error instanceof WechatMediaError && error.statusCode !== undefined && error.statusCode >= 500 && error.statusCode <= 599 ||
                        error instanceof ProviderError && error.options.requestStarted === false && error.options.retryable === true &&
                            (error.code === 'network' || error.code === 'timeout' && ['connect', 'pool'].includes(error.options.timeoutPhase ?? ''));
                    if (attempt < 2 && retryable && !closing.signal.aborted && !signal?.aborted)
                        continue;
                    throw error;
                }
            }
            const media = { encrypt_query_param: downloadParam, aes_key: aeskeyToB64(encrypted.aeskey), encrypt_type: 1 };
            return input.kind === 'image' ? { type: 2, image_item: { media, mid_size: encrypted.paddedSize } }
                : { type: 4, file_item: { media, file_name: input.fileName, len: String(plaintext.byteLength) } };
        }
        catch (error) {
            if (error instanceof WechatMediaError)
                throw error;
            throw new WechatMediaError('upload', 'unknown');
        }
    }
    return { downloadImage, prepareItem,
        async close() {
            if (closed)
                return;
            closed = true;
            closing.abort();
            try {
                if (opening && !transport)
                    transport = await opening;
                await transport?.close?.();
            }
            catch {
                throw new WechatMediaError('configure', 'unknown');
            }
        },
    };
}
/** 共享微信图片筛选、配额和顺序，宿主提供已授权的暂存端口。 */
export async function processWechatImages(items, media, options, stage) {
    const budget = createImMediaBudget(options.maxBytes, options.maxFiles);
    for (const [index, item] of items.entries()) {
        options.signal.throwIfAborted();
        if (item.kind !== 'image')
            continue;
        if (!budget.remaining)
            throw new WechatMediaError('download', 'rejected');
        const file = await media.downloadImage(item.item, options.signal, options.authorize);
        options.signal.throwIfAborted();
        if (!file)
            continue;
        if (!budget.consume(file.bytes.byteLength))
            throw new WechatMediaError('download', 'rejected');
        await stage({ name: '图片', voice: false, ...file }, index, item.source === 'quote');
    }
}
