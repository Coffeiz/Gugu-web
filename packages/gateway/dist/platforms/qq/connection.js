const intents = (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26);
const reconnectDelays = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const events = new Set(['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'INTERACTION_CREATE']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const defaultClock = {
    now: () => performance.now(),
    sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new Error('QQ 连接已取消'));
                return;
            }
            const abort = () => { clearTimeout(timer); reject(new Error('QQ 连接已取消')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
            signal.addEventListener('abort', abort, { once: true });
        });
    },
};
/** QQ raw WebSocket 协议运行时。Token 仅用于内存握手，不进入 URL、公开错误或日志。 */
export function createQqConnection(ports) {
    const lifetime = new AbortController();
    const clock = ports.clock ?? defaultClock;
    let socket;
    let sessionId;
    let lastSeq;
    let attempt = 0;
    let closeSocket;
    let cleanupFailed = false;
    async function run() {
        while (!lifetime.signal.aborted) {
            const connection = new AbortController();
            const signal = AbortSignal.any([lifetime.signal, connection.signal]);
            let heartbeat;
            let heartbeatController;
            let current;
            let lastAck = clock.now();
            let closing;
            let ready = false;
            const close = () => {
                if (!closing)
                    closing = (async () => {
                        try {
                            await current?.close();
                        }
                        catch (error) {
                            cleanupFailed = true;
                            ports.report?.('cleanup-failed', error);
                        }
                    })();
                return closing;
            };
            const abort = () => { void close(); };
            try {
                const token = await ports.getAccessToken(signal);
                if (!token)
                    throw new Error();
                const url = await ports.getGateway(token, signal);
                signal.throwIfAborted();
                current = await ports.openSocket(url, signal);
                socket = current;
                closeSocket = close;
                signal.addEventListener('abort', abort, { once: true });
                signal.throwIfAborted();
                attempt = 0;
                for await (const raw of current.packets) {
                    signal.throwIfAborted();
                    if (!object(raw) || !Number.isSafeInteger(raw.op))
                        throw new Error();
                    const sequence = typeof raw.s === 'number' && Number.isSafeInteger(raw.s) ? raw.s : undefined;
                    const businessDispatch = raw.op === 0 && typeof raw.t === 'string' && events.has(raw.t);
                    // 可处理事件必须先可靠接收入队，再提交RESUME水位，避免失败消息被跳过。
                    if (!businessDispatch && sequence !== undefined)
                        lastSeq = sequence;
                    const data = object(raw.d) ? raw.d : {};
                    if (raw.op === 10) {
                        heartbeatController?.abort();
                        await heartbeat;
                        heartbeatController = new AbortController();
                        const heartbeatSignal = AbortSignal.any([signal, heartbeatController.signal]);
                        const interval = typeof data.heartbeat_interval === 'number' && Number.isFinite(data.heartbeat_interval) && data.heartbeat_interval > 0 ? data.heartbeat_interval : 45_000;
                        lastAck = clock.now();
                        heartbeat = (async () => {
                            try {
                                while (!heartbeatSignal.aborted) {
                                    await clock.sleep(interval, heartbeatSignal);
                                    if (heartbeatSignal.aborted)
                                        return;
                                    if (clock.now() - lastAck >= interval * 2.5) {
                                        ports.report?.('heartbeat-timeout');
                                        await close();
                                        connection.abort();
                                        return;
                                    }
                                    await current.send({ op: 1, d: lastSeq ?? null });
                                }
                            }
                            catch (error) {
                                if (!heartbeatSignal.aborted) {
                                    ports.report?.('heartbeat-failed', error);
                                    await close();
                                    connection.abort();
                                }
                            }
                        })();
                        if (sessionId && lastSeq !== undefined)
                            await current.send({ op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq } });
                        else
                            await current.send({ op: 2, d: { token: `QQBot ${token}`, intents, shard: [0, 1] } });
                    }
                    else if (raw.op === 11)
                        lastAck = clock.now();
                    else if (raw.op === 0) {
                        if (raw.t === 'READY' || raw.t === 'RESUMED') {
                            if (raw.t === 'READY')
                                sessionId = typeof data.session_id === 'string' && data.session_id ? data.session_id : undefined;
                            if (sessionId && !ready) {
                                ready = true;
                                ports.onReadyChange?.(true);
                            }
                        }
                        else if (typeof raw.t === 'string' && events.has(raw.t)) {
                            try {
                                await ports.onEvent(raw.t, data, signal);
                            }
                            catch (error) {
                                if (!signal.aborted)
                                    ports.report?.('event-failed', error);
                                break; // 保留最后成功水位，由下一条连接重新接收。
                            }
                            if (sequence !== undefined)
                                lastSeq = sequence;
                        }
                    }
                    else if (raw.op === 7)
                        break;
                    else if (raw.op === 9) {
                        sessionId = undefined;
                        lastSeq = undefined;
                        break;
                    }
                }
            }
            catch (error) {
                if (!signal.aborted)
                    ports.report?.('connection-failed', error);
            }
            finally {
                if (ready)
                    ports.onReadyChange?.(false);
                connection.abort();
                heartbeatController?.abort();
                signal.removeEventListener('abort', abort);
                await close();
                await heartbeat;
                if (socket === current) {
                    socket = undefined;
                    closeSocket = undefined;
                }
                // 关闭未确认时不能继续建立第二条连接；由可信Host处理清理失败。
                if (cleanupFailed)
                    throw new Error('QQ 连接未能完全停止');
            }
            if (lifetime.signal.aborted)
                break;
            await clock.sleep(reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)], lifetime.signal).catch(() => undefined);
            attempt++;
        }
    }
    const closed = run();
    return { closed, async stop() { lifetime.abort(); await closeSocket?.(); await closed; } };
}
