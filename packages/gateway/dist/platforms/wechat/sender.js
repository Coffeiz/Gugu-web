import { randomUUID } from 'node:crypto';
import { ILinkApiError } from './client.js';
import { WECHAT_MEDIA_MAX_BYTES, WechatMediaError } from './media.js';
import { createWechatTypingIndicator, createWechatTypingTicketCache } from './typing.js';
function validTarget(target) {
    return !!target && typeof target.userId === 'string' && !!target.userId && target.userId.length <= 512 &&
        typeof target.contextToken === 'string' && !!target.contextToken && target.contextToken.length <= 8192 &&
        !/[\x00-\x1f\x7f]/.test(target.userId + target.contextToken);
}
const rejected = () => ({ outcome: 'rejected' });
function failure(error) {
    return { outcome: error instanceof ILinkApiError || error instanceof WechatMediaError ? error.outcome : 'unknown' };
}
/** 单Bot出站组合器；同一用户的文本和媒体串行，Host负责绑定授权及client/media生命周期。 */
export function createWechatSender(options) {
    const tails = new Map();
    const closing = new AbortController();
    const cache = typeof options.client.getConfig === 'function' && typeof options.client.sendTyping === 'function'
        ? createWechatTypingTicketCache({ getConfig: options.client.getConfig }, options.typing) : null;
    const indicators = new Map();
    const pendingStops = new Set();
    async function stopTyping(target, expected) {
        const entry = indicators.get(target.userId);
        if (!entry || expected && entry.value !== expected)
            return 'stopped';
        indicators.delete(target.userId);
        if (entry.abort)
            entry.signal?.removeEventListener('abort', entry.abort);
        const pending = entry.value.stop();
        pendingStops.add(pending);
        try {
            return await pending;
        }
        finally {
            pendingStops.delete(pending);
        }
    }
    async function startTyping(target, authorize, signal) {
        if (typeof options.client.sendTyping !== 'function')
            return { status: 'unavailable', reason: 'not_configured' };
        if (!validTarget(target))
            return { status: 'unavailable', reason: 'invalid_target' };
        target = Object.freeze({ userId: target.userId, contextToken: target.contextToken, typingTicket: target.typingTicket });
        if (closing.signal.aborted || signal?.aborted)
            return { status: 'unavailable', reason: 'cancelled' };
        try {
            if (typeof authorize !== 'function' || !await authorize())
                return { status: 'unavailable', reason: 'unauthorized' };
            const existing = indicators.get(target.userId);
            if (existing?.context === target.contextToken && existing.value.isRunning())
                return { status: 'started', indicator: existing.value };
            if (existing)
                await stopTyping(target);
            const combined = AbortSignal.any([closing.signal, ...(signal ? [signal] : [])]);
            const ticket = target.typingTicket && target.typingTicket.length <= 16384 ? { status: 'ready', ticket: target.typingTicket, stale: false }
                : cache ? await cache.get(target.userId, target.contextToken, combined) : { status: 'unavailable', reason: 'not_configured' };
            if (ticket.status !== 'ready')
                return ticket;
            combined.throwIfAborted();
            const indicator = createWechatTypingIndicator({ ...options.typing, client: { sendTyping: options.client.sendTyping },
                userId: target.userId, ticket: ticket.ticket, authorize });
            const entry = { context: target.contextToken, value: indicator, signal: combined, abort: () => { void stopTyping(target, indicator); } };
            indicators.set(target.userId, entry);
            combined.addEventListener('abort', entry.abort, { once: true });
            await indicator.start();
            return { status: 'started', indicator };
        }
        catch {
            return { status: 'unavailable', reason: signal?.aborted || closing.signal.aborted ? 'cancelled' : 'api_failed' };
        }
    }
    function enqueue(target, buildItem, signal, authorize, deliveryId) {
        if (!validTarget(target) || signal?.aborted || closing.signal.aborted)
            return Promise.resolve(rejected());
        signal = AbortSignal.any([closing.signal, ...(signal ? [signal] : [])]);
        // 调用方后续修改对象不能改变已经排队消息的收件人或会话凭证。
        const bound = Object.freeze({ userId: target.userId, contextToken: target.contextToken });
        const previous = tails.get(bound.userId) ?? Promise.resolve();
        let tail;
        const result = previous.then(async () => {
            if (signal?.aborted || authorize && await authorize() !== true)
                return rejected();
            await stopTyping(bound);
            if (signal?.aborted)
                return rejected();
            let clientId;
            try {
                clientId = deliveryId ?? (options.generateId ?? randomUUID)();
            }
            catch {
                return rejected();
            }
            if (typeof clientId !== 'string' || !clientId || clientId.length > 128 || /[\x00-\x1f\x7f]/.test(clientId))
                return rejected();
            try {
                const item = await buildItem(bound);
                if (signal?.aborted || authorize && await authorize() !== true)
                    return rejected();
                // 一次逻辑发送只调用一次sendMessage，不在这里重传媒体或重建client_id。
                const response = await options.client.sendMessage({ from_user_id: '', to_user_id: bound.userId, client_id: clientId,
                    message_type: 2, message_state: 2, context_token: bound.contextToken, item_list: [item] }, signal, authorize);
                if (!response || typeof response !== 'object' || Array.isArray(response))
                    return { outcome: 'unknown' };
                if (response.ret !== undefined && response.ret !== null && response.ret !== 0)
                    return rejected();
                return { outcome: 'accepted' };
            }
            catch (error) {
                return failure(error);
            }
        });
        tail = result.then(() => { }, () => { }).finally(() => { if (tails.get(bound.userId) === tail)
            tails.delete(bound.userId); });
        tails.set(bound.userId, tail);
        return result;
    }
    return {
        text(target, value, signal, authorize, deliveryId) {
            if (typeof value !== 'string' || !value)
                return Promise.resolve(rejected());
            return enqueue(target, async () => ({ type: 1, text_item: { text: value } }), signal, authorize, deliveryId);
        },
        image(target, bytes, signal, authorize) {
            if (!validTarget(target) || signal?.aborted || !(bytes instanceof Uint8Array) || bytes.byteLength > WECHAT_MEDIA_MAX_BYTES)
                return Promise.resolve(rejected());
            const data = Buffer.from(bytes);
            return enqueue(target, bound => options.media.prepareItem({ kind: 'image', data, toUserId: bound.userId, authorize }, signal), signal, authorize);
        },
        file(target, bytes, fileName, signal, authorize) {
            if (!validTarget(target) || signal?.aborted || !(bytes instanceof Uint8Array) || bytes.byteLength > WECHAT_MEDIA_MAX_BYTES || typeof fileName !== 'string' || !fileName || fileName.length > 255 || /[\x00-\x1f\x7f]/.test(fileName))
                return Promise.resolve(rejected());
            const data = Buffer.from(bytes);
            return enqueue(target, bound => options.media.prepareItem({ kind: 'file', data, fileName, toUserId: bound.userId, authorize }, signal), signal, authorize);
        },
        async idle() { while (tails.size)
            await Promise.all([...tails.values()]); },
        startTyping,
        stopTyping: (target) => stopTyping(target),
        /** 只迭代实际Run一次；未读到运行事件不启动，平台故障不吞业务生成器异常。 */
        async *observeRun(target, events, authorize, signal) {
            target = Object.freeze({ userId: target.userId, contextToken: target.contextToken, typingTicket: target.typingTicket });
            let indicator;
            try {
                for await (const event of events) {
                    if (['interaction_required', 'final'].includes(event.type)) {
                        if (indicator)
                            await stopTyping(target, indicator);
                        indicator = undefined;
                    }
                    else if (!indicator && ['run_started', 'run_resumed', 'round_start'].includes(event.type)) {
                        const started = await startTyping(target, authorize, signal);
                        if (started.status === 'started')
                            indicator = started.indicator;
                    }
                    yield event;
                }
            }
            finally {
                if (indicator)
                    await stopTyping(target, indicator);
            }
        },
        async close() {
            closing.abort();
            for (const [userId] of indicators)
                await stopTyping({ userId, contextToken: '' });
            await Promise.all([...pendingStops]);
            await cache?.close();
            while (tails.size)
                await Promise.all([...tails.values()]);
        },
    };
}
