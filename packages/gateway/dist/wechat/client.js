import { randomInt, randomUUID } from 'node:crypto';
import { ProviderError } from '@gugu/core/providers';
export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_CHANNEL_VERSION = '2.0.1';
const responseLimit = 4 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const baseInfo = () => ({ channel_version: ILINK_CHANNEL_VERSION });
/** 不持有原异常、上下文凭证、请求URL或平台原始响应。 */
export class ILinkApiError extends Error {
    operation;
    outcome;
    statusCode;
    ret;
    constructor(operation, outcome, statusCode, ret) {
        super('微信 iLink 请求失败');
        this.operation = operation;
        this.outcome = outcome;
        this.statusCode = statusCode;
        this.ret = ret;
        this.name = 'ILinkApiError';
    }
}
/** 扫码返回的可信配置仍不得把Bearer凭据送往任意主机或路径。 */
export function validateILinkBaseUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
            (url.pathname !== '/' && url.pathname !== '') || !url.hostname.endsWith('.weixin.qq.com'))
            throw new Error();
        return url.origin;
    }
    catch {
        throw new ILinkApiError('configure', 'rejected');
    }
}
/** 仅封装当前iLink HTTP协议；连接监督、游标和业务授权由Host调用方负责。 */
export function createILinkClient(options) {
    const baseUrl = validateILinkBaseUrl(options.baseUrl || ILINK_DEFAULT_BASE_URL);
    if (!options.botToken || /[\r\n\0]/.test(options.botToken))
        throw new ILinkApiError('configure', 'rejected');
    let transport = options.transport;
    let opening;
    let closed = false;
    const closing = new AbortController();
    async function network() {
        if (closed)
            throw new ILinkApiError('closed', 'rejected');
        if (!transport) {
            opening ??= import('@gugu/core/providers/node').then(({ NodeProviderTransport }) => new NodeProviderTransport());
            transport = await opening;
            if (closed)
                throw new ILinkApiError('closed', 'rejected');
        }
        return transport;
    }
    function headers() {
        const uin = (options.randomUin ?? (() => randomInt(0xFFFFFFFF)))();
        if (!Number.isSafeInteger(uin) || uin < 0 || uin >= 0xFFFFFFFF)
            throw new ILinkApiError('configure', 'rejected');
        return { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
            'X-WECHAT-UIN': Buffer.from(String(uin), 'ascii').toString('base64'), Authorization: `Bearer ${options.botToken}` };
    }
    async function decode(response, signal) {
        const declared = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > responseLimit))
            throw new Error();
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            signal.throwIfAborted();
            size += chunk.byteLength;
            if (size > responseLimit)
                throw new Error();
            chunks.push(chunk);
        }
        signal.throwIfAborted();
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!object(result))
            throw new Error();
        return result;
    }
    async function post(operation, body, timeoutMs, signal, retryBeforeSend = false, authorize) {
        let serialized;
        try {
            serialized = Buffer.from(JSON.stringify(body));
        }
        catch {
            throw new ILinkApiError(operation, 'rejected');
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            let response;
            const timeout = new AbortController();
            const combined = AbortSignal.any([closing.signal, timeout.signal, ...(signal ? [signal] : [])]);
            const timer = setTimeout(() => timeout.abort(), timeoutMs);
            const cancel = () => { void (async () => { try {
                await response?.cancel();
            }
            catch { /* 清理不得泄露网络异常。 */ } })(); };
            combined.addEventListener('abort', cancel, { once: true });
            try {
                combined.throwIfAborted();
                const activeTransport = await network();
                if (authorize && await authorize() !== true)
                    throw new ILinkApiError(operation, 'rejected', 403);
                combined.throwIfAborted();
                response = await activeTransport.request({ url: `${baseUrl}/ilink/bot/${operation}`, method: 'POST', headers: headers(), body: serialized, timeoutMs }, combined);
                combined.throwIfAborted();
                if (response.status < 200 || response.status >= 300)
                    throw new ILinkApiError(operation, response.status >= 300 && response.status < 500 ? 'rejected' : 'unknown', response.status);
                const result = await decode(response, combined);
                if (result.ret !== undefined && result.ret !== null && result.ret !== 0) {
                    throw new ILinkApiError(operation, 'rejected', response.status, typeof result.ret === 'number' && Number.isSafeInteger(result.ret) ? result.ret : undefined);
                }
                return result;
            }
            catch (error) {
                // 仅可信transport明确证明未发送的连接失败允许重试；body/client_id始终相同。
                if (retryBeforeSend && attempt === 0 && !response && !combined.aborted && error instanceof ProviderError &&
                    error.options.requestStarted === false && error.options.retryable === true &&
                    (error.code === 'network' || error.code === 'timeout' && ['connect', 'pool'].includes(error.options.timeoutPhase ?? '')))
                    continue;
                if (error instanceof ILinkApiError)
                    throw error;
                throw new ILinkApiError(operation, 'unknown', response?.status);
            }
            finally {
                clearTimeout(timer);
                combined.removeEventListener('abort', cancel);
                try {
                    await response?.cancel();
                }
                catch { /* 不传播原始错误。 */ }
            }
        }
        throw new ILinkApiError(operation, 'unknown');
    }
    function sendMessage(message, signal, authorize) {
        if (typeof message.context_token !== 'string' || !message.context_token)
            return Promise.reject(new ILinkApiError('sendmessage', 'rejected'));
        return post('sendmessage', { msg: message, base_info: baseInfo() }, 15_000, signal, true, authorize);
    }
    return {
        getUpdates(cursor = '', signal) { return post('getupdates', { get_updates_buf: cursor, base_info: baseInfo() }, 45_000, signal); },
        sendMessage,
        sendText(toUserId, text, contextToken, signal) {
            return sendMessage({ from_user_id: '', to_user_id: toUserId, client_id: (options.generateId ?? randomUUID)(),
                message_type: 2, message_state: 2, context_token: contextToken, item_list: [{ type: 1, text_item: { text } }] }, signal);
        },
        getUploadUrl(body = {}, signal, authorize) { return post('getuploadurl', { base_info: baseInfo(), ...body }, 15_000, signal, false, authorize); },
        getConfig(userId, contextToken = '', signal) { return post('getconfig', { ilink_user_id: userId, context_token: contextToken, base_info: baseInfo() }, 15_000, signal); },
        sendTyping(userId, ticket, status, signal) {
            return ticket ? post('sendtyping', { ilink_user_id: userId, typing_ticket: ticket, status, base_info: baseInfo() }, 15_000, signal)
                : Promise.resolve({ ret: 0, errmsg: 'no typing_ticket, skipped' });
        },
        notifyStart(signal) { return post('msg/notifystart', { base_info: baseInfo() }, 15_000, signal); },
        notifyStop(signal) { return post('msg/notifystop', { base_info: baseInfo() }, 15_000, signal); },
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
                throw new ILinkApiError('close', 'unknown');
            }
        },
    };
}
