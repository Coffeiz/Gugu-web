import { randomBytes } from 'node:crypto';
const base = 'https://api.telegram.org';
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const responseLimit = 4 * 1024 * 1024;
/** 错误只持有协议状态，不保留 URL、Token、原始异常或上游正文。 */
export class TelegramApiError extends Error {
    operation;
    statusCode;
    errorCode;
    retryAfter;
    constructor(operation, statusCode, errorCode, retryAfter) {
        super(`Telegram ${operation} 请求失败`);
        this.operation = operation;
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.retryAfter = retryAfter;
        this.name = 'TelegramApiError';
    }
}
export function validateTelegramBotToken(token) {
    const value = token.trim();
    if (value.length > 160 || !/^[0-9]{5,20}:[A-Za-z0-9_-]{20,128}$/.test(value))
        throw new Error('Telegram Bot Token 格式无效');
    return value;
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function integer(value) { return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined; }
/** 官方协议要求 Token 置于内部请求路径；该例外不允许任意目标、重定向或记录请求 URL。 */
export function createTelegramBotApi(options = {}) {
    let transport = options.transport;
    let opening;
    let closed = false;
    async function getTransport() {
        if (closed)
            throw new Error();
        if (!transport) {
            opening ??= import('@gugu/core/providers/node').then(({ NodeProviderTransport }) => new NodeProviderTransport());
            transport = await opening;
            if (closed) {
                await transport.close?.();
                throw new Error();
            }
        }
        return transport;
    }
    async function bytes(response, maxBytes, signal) {
        const length = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
        if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes))
            throw new Error();
        const chunks = [];
        let total = 0;
        for await (const chunk of response.body) {
            signal.throwIfAborted();
            total += chunk.byteLength;
            if (total > maxBytes)
                throw new Error();
            chunks.push(chunk);
        }
        signal.throwIfAborted();
        return Buffer.concat(chunks, total);
    }
    async function request(operation, input, signal, limit, parse, authorize) {
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const timeout = input.timeoutMs ?? 20_000;
        if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 300_000)
            throw new TelegramApiError(operation);
        let response;
        const timer = setTimeout(() => controller.abort(), timeout);
        const cancel = () => { void (async () => { try {
            await response?.cancel();
        }
        catch { /* 取消回调不传播底层网络错误。 */ } })(); };
        combined.addEventListener('abort', cancel, { once: true });
        try {
            combined.throwIfAborted();
            const network = await getTransport();
            if (authorize && !await authorize())
                throw new TelegramApiError(operation, 403);
            combined.throwIfAborted();
            response = await network.request(input, combined);
            combined.throwIfAborted();
            if (response.status >= 300 && response.status < 400)
                throw new TelegramApiError(operation, response.status);
            const body = await bytes(response, limit, combined);
            return parse(body, response.status);
        }
        catch (error) {
            if (error instanceof TelegramApiError)
                throw error;
            throw new TelegramApiError(operation, response?.status);
        }
        finally {
            clearTimeout(timer);
            combined.removeEventListener('abort', cancel);
            try {
                await response?.cancel();
            }
            catch { /* 清理错误不替换安全协议错误。 */ }
        }
    }
    function multipart(payload, files) {
        const boundary = `gugu-${randomBytes(24).toString('hex')}`;
        const pieces = [];
        const line = (value) => pieces.push(Buffer.from(value));
        for (const [key, value] of Object.entries(payload)) {
            if (!/^[A-Za-z0-9_]{1,64}$/.test(key))
                throw new Error();
            line(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`);
        }
        for (const [key, file] of Object.entries(files)) {
            if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || !file.name || /[\r\n\0"\\]/.test(file.name) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.contentType) || !(file.data instanceof Uint8Array))
                throw new Error();
            line(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`);
            pieces.push(file.data);
            line('\r\n');
        }
        line(`--${boundary}--\r\n`);
        return { body: Buffer.concat(pieces), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
    }
    async function call(token, method, args = {}) {
        const safeToken = validateTelegramBotToken(token);
        if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(method))
            throw new Error('Telegram API 方法名无效');
        let body;
        let headers;
        try {
            if (args.files && Object.keys(args.files).length)
                ({ body, headers } = multipart(args.payload ?? {}, args.files));
            else {
                body = Buffer.from(JSON.stringify(args.payload ?? {}));
                headers = { 'content-type': 'application/json' };
            }
        }
        catch {
            throw new TelegramApiError(method);
        }
        return request(method, { url: `${base}/bot${safeToken}/${method}`, method: 'POST', headers, body, timeoutMs: args.timeoutMs ?? 20_000 }, args.signal, responseLimit, (raw, status) => {
            let data;
            try {
                data = JSON.parse(raw.toString('utf8'));
            }
            catch {
                throw new TelegramApiError(method, status);
            }
            if (status < 200 || status >= 300 || !object(data) || data.ok !== true) {
                const parameters = object(data) && object(data.parameters) ? data.parameters : {};
                throw new TelegramApiError(method, status, object(data) ? integer(data.error_code) : undefined, integer(parameters.retry_after));
            }
            return data.result;
        }, args.authorize);
    }
    async function downloadFile(token, filePath, args = {}) {
        const safeToken = validateTelegramBotToken(token);
        const limit = args.maxBytes ?? TELEGRAM_DOWNLOAD_MAX_BYTES;
        if (!filePath || filePath.length > 512 || !/^[A-Za-z0-9_./-]+$/.test(filePath) || filePath.split('/').some(part => part === '.' || part === '..') || !Number.isSafeInteger(limit) || limit <= 0 || limit > TELEGRAM_DOWNLOAD_MAX_BYTES)
            throw new TelegramApiError('getFile');
        return request('getFile', { url: `${base}/file/bot${safeToken}/${filePath}`, method: 'GET', headers: {}, timeoutMs: 60_000 }, args.signal, limit, (data, status) => {
            if (status < 200 || status >= 300)
                throw new TelegramApiError('getFile', status);
            return data;
        }, args.authorize);
    }
    return {
        call, downloadFile,
        async close() {
            closed = true;
            try {
                if (opening && !transport)
                    transport = await opening;
                await transport?.close?.();
            }
            catch {
                throw new TelegramApiError('close');
            }
        },
    };
}
