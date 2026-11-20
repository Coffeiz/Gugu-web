import { Agent } from 'node:https';
import WebSocket from 'ws';
import { resolvePinnedTarget } from '@gugu/core/providers/node';
/** 每次握手单独校验并固定DNS；代理部署须注入另一个经过验收的连接工厂。 */
export function createQqSocketFactory(options) {
    if (options.allowDirect !== true)
        throw new Error('QQ 长连接网络策略未配置');
    return async (value, signal) => {
        let url;
        let target;
        try {
            if (/[\x00-\x20\x7f\\]/.test(value))
                throw new Error();
            url = new URL(value);
            if (url.protocol !== 'wss:' || !['api.sgroup.qq.com', 'sandbox.api.sgroup.qq.com'].includes(url.hostname)
                || !/^\/websocket\/?$/.test(url.pathname) || url.port || url.username || url.password || url.search || url.hash)
                throw new Error();
            const destination = new URL(url);
            destination.protocol = 'https:';
            target = (await resolvePinnedTarget(destination.href, { signal, resolve: options.resolve })).target;
        }
        catch {
            throw new Error('QQ 长连接目标校验失败');
        }
        const lookup = (hostname, settings, callback) => {
            if (hostname !== url.hostname || signal.aborted) {
                callback(new Error('QQ 长连接目标无效'), '', 4);
                return;
            }
            if (settings.all)
                callback(null, [{ address: target.address, family: target.family }]);
            else
                callback(null, target.address, target.family);
        };
        const agent = new Agent({ lookup, keepAlive: false, maxSockets: 1 });
        let socket;
        try {
            signal.throwIfAborted();
            socket = (options.createSocket ?? ((url, settings) => new WebSocket(url, settings)))(url.href, {
                agent, followRedirects: false, handshakeTimeout: 15_000, maxPayload: 1_048_576,
            });
        }
        catch {
            agent.destroy();
            throw new Error('QQ 长连接握手失败');
        }
        let opened = false, ended = false, stopping = false, failed = false, claimed = false;
        let wake;
        let resolveOpen, rejectOpen, resolveClosed;
        const ready = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
        const closed = new Promise(resolve => { resolveClosed = resolve; });
        const queued = [];
        const notify = () => { wake?.(); wake = undefined; };
        const fail = () => {
            failed = true;
            rejectOpen(new Error('QQ 长连接握手失败'));
            try {
                socket.terminate();
            }
            catch { /* close路径会报告未完成清理。 */ }
            notify();
        };
        const abort = () => { stopping = true; queued.length = 0; fail(); };
        socket.once('open', () => { opened = true; resolveOpen(); });
        socket.on('error', fail);
        socket.once('close', () => {
            ended = true;
            rejectOpen(new Error('QQ 长连接握手失败'));
            resolveClosed();
            notify();
        });
        socket.on('unexpected-response', fail);
        socket.on('message', (raw) => {
            if (stopping || ended)
                return;
            if (queued.length >= 64) {
                fail();
                return;
            }
            try {
                const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw;
                if (data.byteLength > 1_048_576)
                    throw new Error();
                queued.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
                notify();
            }
            catch {
                fail();
            }
        });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        let closing;
        const close = () => closing ??= (async () => {
            stopping = true;
            queued.length = 0;
            let timer;
            try {
                if (socket.readyState !== WebSocket.CLOSED)
                    socket.terminate();
                else {
                    ended = true;
                    resolveClosed();
                    notify();
                }
                await Promise.race([closed, new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('QQ 长连接清理失败')), 5_000);
                    })]);
            }
            catch {
                throw new Error('QQ 长连接清理失败');
            }
            finally {
                if (timer)
                    clearTimeout(timer);
                signal.removeEventListener('abort', abort);
                agent.destroy();
                notify();
            }
        })();
        try {
            await ready;
            signal.throwIfAborted();
        }
        catch {
            await close();
            throw new Error('QQ 长连接握手失败');
        }
        return {
            packets: { async *[Symbol.asyncIterator]() {
                    if (claimed)
                        throw new Error('QQ 长连接消息已被消费');
                    claimed = true;
                    while (true) {
                        if (queued.length) {
                            yield queued.shift();
                            continue;
                        }
                        if (stopping)
                            return;
                        if (ended || failed) {
                            if (failed && opened)
                                throw new Error('QQ 长连接接收失败');
                            return;
                        }
                        await new Promise(resolve => { wake = resolve; });
                    }
                } },
            async send(packet) {
                if (stopping || ended || socket.readyState !== WebSocket.OPEN)
                    throw new Error('QQ 长连接发送失败');
                let body;
                try {
                    body = JSON.stringify(packet);
                }
                catch {
                    throw new Error('QQ 长连接发送失败');
                }
                await new Promise((resolve, reject) => {
                    try {
                        socket.send(body, error => error ? reject(new Error('QQ 长连接发送失败')) : resolve());
                    }
                    catch {
                        reject(new Error('QQ 长连接发送失败'));
                    }
                });
            },
            close,
        };
    };
}
