export class QqApiError extends Error {
    operation;
    statusCode;
    errorCode;
    outcome;
    retryable;
    constructor(operation, statusCode, errorCode, outcome = statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 408 ? 'FAILED_CONFIRMED' : 'UNKNOWN') {
        super(`QQ ${operation} 请求失败`);
        this.operation = operation;
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.outcome = outcome;
        this.name = 'QqApiError';
        this.retryable = statusCode === undefined ? this.outcome === 'UNKNOWN' : statusCode >= 500 || [401, 408, 429].includes(statusCode);
    }
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const part = '[A-Za-z0-9_-]{1,256}';
function operation(method, path) {
    if (method === 'GET' && path === '/gateway')
        return 'gateway';
    if (method === 'POST' && new RegExp(`^/v2/(users|groups)/${part}/messages$`).test(path))
        return 'message';
    if (method === 'POST' && new RegExp(`^/v2/users/${part}/stream_messages$`).test(path))
        return 'stream';
    if (method === 'POST' && new RegExp(`^/v2/(users|groups)/${part}/(upload_prepare|upload_part_finish|files)$`).test(path))
        return 'media';
    if (method === 'PUT' && new RegExp(`^/interactions/${part}$`).test(path))
        return 'interaction';
    throw new QqApiError('message', undefined, undefined, 'FAILED_CONFIRMED');
}
/** 实例绑定可信Bot配置；固定REST主机，Token不进入URL或公开错误。 */
export function createQqClient(options) {
    const { appId, appSecret, sandbox } = options;
    if (!appId || !appSecret)
        throw new QqApiError('auth', undefined, undefined, 'FAILED_CONFIRMED');
    const base = sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
    const lifetime = new AbortController();
    const now = options.now ?? Date.now;
    let transport = options.transport, opening;
    let cached;
    let refresh;
    async function request(op, method, url, body, auth, signal, timeoutMs, authorize) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)
            throw new QqApiError(op, undefined, undefined, 'FAILED_CONFIRMED');
        const deadline = new AbortController();
        const combined = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
        const timer = setTimeout(() => deadline.abort(), timeoutMs);
        let response;
        const cancel = () => { void (async () => { try {
            await response?.cancel();
        }
        catch { /* 原始异常不进入公开日志。 */ } })(); };
        combined.addEventListener('abort', cancel, { once: true });
        try {
            combined.throwIfAborted();
            if (!transport) {
                opening ??= import('@gugu/core/providers/node').then(({ NodeProviderTransport }) => new NodeProviderTransport({ trustEnvironment: false }));
                transport = await opening;
            }
            if (authorize && !await authorize())
                throw new QqApiError(op, 403);
            response = await transport.request({ url, method, headers: { 'content-type': 'application/json', ...(auth ? { Authorization: `QQBot ${auth}` } : {}) }, ...(body ? { body: Buffer.from(JSON.stringify(body)) } : {}), timeoutMs }, combined);
            combined.throwIfAborted();
            if (response.status >= 300 && response.status < 400)
                throw new QqApiError(op, response.status);
            const length = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
            if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 4 * 1024 * 1024))
                throw new QqApiError(op, response.status);
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body) {
                combined.throwIfAborted();
                size += chunk.byteLength;
                if (size > 4 * 1024 * 1024)
                    throw new QqApiError(op, response.status);
                chunks.push(chunk);
            }
            combined.throwIfAborted();
            const raw = Buffer.concat(chunks, size);
            let value;
            try {
                value = raw.length ? JSON.parse(raw.toString('utf8')) : response.status === 204 ? {} : null;
            }
            catch {
                throw new QqApiError(op, response.status);
            }
            const code = object(value) && typeof (value.code ?? value.err_code) === 'number' && Number.isSafeInteger(value.code ?? value.err_code) ? Number(value.code ?? value.err_code) : undefined;
            if (![200, 201, 204].includes(response.status) || !object(value) || code !== undefined && code !== 0)
                throw new QqApiError(op, response.status, code, response.status >= 200 && response.status < 300 && code !== undefined && code !== 0 ? 'FAILED_CONFIRMED' : undefined);
            return value;
        }
        catch (error) {
            if (error instanceof QqApiError)
                throw error;
            throw new QqApiError(op, response?.status);
        }
        finally {
            clearTimeout(timer);
            combined.removeEventListener('abort', cancel);
            try {
                await response?.cancel();
            }
            catch { /* 清理失败不传播含敏感内容的底层错误。 */ }
        }
    }
    async function getAccessToken(signal) {
        if (signal?.aborted || lifetime.signal.aborted)
            throw new QqApiError('auth');
        if (cached && cached.expires > now() + 60_000)
            return cached.token;
        if (!refresh) {
            const controller = new AbortController();
            const entry = { controller, waiters: 0, task: Promise.resolve('') };
            entry.task = (async () => {
                const result = await request('auth', 'POST', 'https://bots.qq.com/app/getAppAccessToken', { appId, clientSecret: appSecret }, undefined, controller.signal, 15_000);
                const ttl = typeof result.expires_in === 'string' && /^\d+$/.test(result.expires_in) ? Number(result.expires_in) : result.expires_in ?? 0;
                if (typeof result.access_token !== 'string' || !result.access_token || typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 0 || controller.signal.aborted)
                    throw new QqApiError('auth');
                cached = { token: result.access_token, expires: now() + ttl * 1000 };
                return cached.token;
            })().finally(() => { if (refresh === entry)
                refresh = undefined; });
            refresh = entry;
        }
        const entry = refresh;
        entry.waiters++;
        const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
        let abort;
        try {
            return await Promise.race([entry.task, new Promise((_resolve, reject) => { abort = () => reject(new QqApiError('auth')); combined.addEventListener('abort', abort, { once: true }); if (combined.aborted)
                    abort(); })]);
        }
        finally {
            combined.removeEventListener('abort', abort);
            entry.waiters--;
            if (entry.waiters === 0 && refresh === entry) {
                refresh = undefined;
                entry.controller.abort();
            }
        }
    }
    async function call(method, path, args = {}) {
        const op = operation(method, path);
        let auth = await getAccessToken(args.signal);
        let result;
        try {
            result = await request(op, method, base + path, args.body, auth, args.signal, args.timeoutMs ?? 20_000, args.authorize);
        }
        catch (error) {
            // 只有明确401代表旧凭据被拒绝；超时/5xx的写入结果未知，不自动重发。
            if (!(error instanceof QqApiError) || error.statusCode !== 401)
                throw error;
            if (cached?.token === auth)
                cached = undefined;
            auth = await getAccessToken(args.signal);
            result = await request(op, method, base + path, args.body, auth, args.signal, args.timeoutMs ?? 20_000, args.authorize);
        }
        if (op === 'message' && ![result.id, result.message_id].some(id => typeof id === 'string' && id.trim()))
            throw new QqApiError(op, 200, undefined, 'UNKNOWN');
        if (op === 'stream' && ![result.stream_msg_id, result.id].some(id => typeof id === 'string' && id.trim()))
            throw new QqApiError(op, 200, undefined, 'UNKNOWN');
        return result;
    }
    async function getGateway(signal) {
        try {
            const result = await call('GET', '/gateway', { signal, timeoutMs: 15_000 });
            if (typeof result.url !== 'string')
                throw new QqApiError('gateway');
            const endpoint = new URL(result.url);
            if (endpoint.protocol !== 'wss:' || !['api.sgroup.qq.com', 'sandbox.api.sgroup.qq.com'].includes(endpoint.hostname) || endpoint.port && endpoint.port !== '443' || !['/websocket', '/websocket/'].includes(endpoint.pathname) || endpoint.search || endpoint.hash || endpoint.username || endpoint.password)
                throw new QqApiError('gateway');
            const { resolvePinnedTarget } = await import('@gugu/core/providers/node');
            await resolvePinnedTarget(`https://${endpoint.host}${endpoint.pathname}`, { resolve: options.resolveGateway, signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal });
            return result.url;
        }
        catch {
            throw new QqApiError('gateway');
        }
    }
    return { call, getAccessToken, getGateway, async close() {
            lifetime.abort();
            refresh?.controller.abort();
            cached = undefined;
            try {
                if (!transport && opening)
                    transport = await opening;
                await transport?.close?.();
            }
            catch {
                throw new QqApiError('close');
            }
        } };
}
