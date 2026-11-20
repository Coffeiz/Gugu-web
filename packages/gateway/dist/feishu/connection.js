import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { GatewayConnectionCleanupError } from '../index.js';
const eventNames = ['im.message.receive_v1', 'card.action.trigger', 'im.message.reaction.created_v1', 'im.message.reaction.deleted_v1'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeError = () => new Error('飞书连接失败');
/** 使用真实SDK协议；没有可信安全WS Agent时不提供生产默认连接。 */
export async function createFeishuConnection(options) {
    if (!/^cli_[0-9a-fA-F]{16}$/.test(options.appId) || !options.appSecret || !options.wsNetwork)
        throw safeError();
    const timeoutMs = options.readyTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)
        throw safeError();
    const lifetime = new AbortController();
    let transport = options.transport;
    let opening;
    let stopping = false, connected = false;
    let sdk;
    let serial = Promise.resolve();
    const controls = new Set();
    let cleanup;
    let resolveClosed, rejectClosed;
    const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    // 初始握手失败时调用方尚未收到GatewayConnection；仍消费closed拒绝，避免悬空拒绝。
    void closed.catch(() => undefined);
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const logger = {
        error: () => options.report?.('sdk-error'), warn: () => options.report?.('sdk-warning'),
        info: () => { }, debug: () => { }, trace: () => { },
    };
    const dispatcher = new EventDispatcher({ logger, loggerLevel: LoggerLevel.trace });
    function matchesApp(data) {
        // SDK将schema2 header合并到业务event，沿用Python存在app_id时验证实例归属。
        if (object(data) && data.app_id && data.app_id !== options.appId) {
            options.report?.('misrouted-event');
            return false;
        }
        return true;
    }
    function enqueue(work) {
        if (stopping)
            return Promise.reject(safeError());
        const task = serial.then(async () => {
            if (stopping)
                throw safeError();
            try {
                return await work();
            }
            catch (error) {
                options.report?.('event-failed', error);
                throw safeError();
            }
        });
        serial = task.then(() => undefined, () => undefined);
        return task;
    }
    function control(work) {
        if (stopping)
            return Promise.reject(safeError());
        // 卡片是有响应时限的控制信号，不能排在普通消息/媒体暂存之后。
        // 独立跟踪在途回调；一次性动作与授权仍由可信交互端口校验。
        const task = Promise.resolve().then(async () => {
            if (stopping)
                throw safeError();
            try {
                return await work();
            }
            catch (error) {
                options.report?.('event-failed', error);
                throw safeError();
            }
        });
        controls.add(task);
        void task.then(() => controls.delete(task), () => controls.delete(task));
        return task;
    }
    dispatcher.register({
        'im.message.receive_v1': (data) => matchesApp(data) ? enqueue(() => options.onMessage(data, lifetime.signal)) : undefined,
        'card.action.trigger': (data) => matchesApp(data) ? control(() => options.onCardAction(data, lifetime.signal)) : undefined,
        'im.message.reaction.created_v1': () => undefined,
        'im.message.reaction.deleted_v1': () => undefined,
    });
    async function discover(input) {
        let response;
        const timeout = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, timeout.signal]);
        const timer = setTimeout(() => timeout.abort(), 15_000);
        const cancel = () => { void (async () => { try {
            await response?.cancel();
        }
        catch { /* 不输出底层URL或响应。 */ } })(); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
            if (input.method?.toLowerCase() !== 'post' || input.url !== 'https://open.feishu.cn/callback/ws/endpoint' || !object(input.data) || input.data.AppID !== options.appId || input.data.AppSecret !== options.appSecret)
                throw safeError();
            signal.throwIfAborted();
            if (!transport) {
                opening ??= import('@gugu/core/providers/node').then(({ NodeProviderTransport }) => new NodeProviderTransport());
                transport = await opening;
            }
            response = await transport.request({ url: 'https://open.feishu.cn/callback/ws/endpoint', method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ AppID: options.appId, AppSecret: options.appSecret })), timeoutMs: 15_000 }, signal);
            if (response.status < 200 || response.status >= 300)
                throw safeError();
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body) {
                signal.throwIfAborted();
                size += chunk.byteLength;
                if (size > 1024 * 1024)
                    throw safeError();
                chunks.push(chunk);
            }
            const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
            if (!object(data) || data.code !== 0 || !object(data.data) || typeof data.data.URL !== 'string' || !object(data.data.ClientConfig))
                throw safeError();
            const endpoint = new URL(data.data.URL);
            if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.hash)
                throw safeError();
            await options.wsNetwork.validateEndpoint(data.data.URL, signal);
            signal.throwIfAborted();
            return data;
        }
        catch {
            throw safeError();
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            try {
                await response?.cancel();
            }
            catch { /* 固定错误由SDK logger出口处理。 */ }
        }
    }
    const refused = async () => { throw safeError(); };
    const http = {
        async request(input) { return await discover(input); },
        get: refused, delete: refused, head: refused, options: refused, post: refused, put: refused, patch: refused,
    };
    async function finish() {
        if (cleanup)
            return cleanup;
        stopping = true;
        lifetime.abort();
        clearTimeout(readyTimer);
        cleanup = Promise.resolve().then(async () => {
            let failed = false;
            try {
                sdk?.close({ force: true });
            }
            catch {
                failed = true;
            }
            dispatcher.unregister(...eventNames);
            await Promise.all([serial, Promise.allSettled([...controls])]);
            try {
                if (!transport && opening)
                    transport = await opening;
                await transport?.close?.();
            }
            catch {
                failed = true;
            }
            try {
                await options.wsNetwork.close();
            }
            catch {
                failed = true;
            }
            options.signal?.removeEventListener('abort', abort);
            if (failed) {
                options.report?.('cleanup-failed');
                const error = safeError();
                rejectClosed(error);
                rejectReady(error);
                throw error;
            }
            resolveClosed();
            if (!connected)
                rejectReady(safeError());
        });
        return cleanup;
    }
    const abort = () => { void finish().catch(() => undefined); };
    const readyTimer = setTimeout(() => { options.report?.('connection-failed'); abort(); }, timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
        if (options.signal?.aborted)
            throw safeError();
        sdk = (options.createSdkClient ?? (config => new WSClient(config)))({
            appId: options.appId, appSecret: options.appSecret, domain: 'https://open.feishu.cn',
            logger, loggerLevel: LoggerLevel.trace, httpInstance: http, autoReconnect: true,
            agent: options.wsNetwork.agent, handshakeTimeoutMs: timeoutMs,
            onReady: () => { if (!stopping) {
                connected = true;
                clearTimeout(readyTimer);
                resolveReady();
            } },
            onError: () => { options.report?.('connection-failed'); abort(); },
            onReconnecting: () => options.report?.('reconnecting'), onReconnected: () => options.report?.('reconnected'),
        });
        lifetime.signal.throwIfAborted();
        void sdk.start({ eventDispatcher: dispatcher }).catch(() => { options.report?.('connection-failed'); abort(); });
        await ready;
        return { closed, stop: finish };
    }
    catch {
        try {
            await finish();
        }
        catch {
            throw new GatewayConnectionCleanupError();
        }
        throw safeError();
    }
}
