import { setTimeout as delay } from 'node:timers/promises';
import { normalizeTelegramMessage } from './message.js';
import { GatewayConnectionCleanupError } from '../../contracts.js';
import { TelegramApiError } from './client.js';
import { verifyTelegramBotIdentity } from './pairing.js';
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** 每 Bot 长轮询；不替代 IM 入站事务、权限与 Agent 运行处理。 */
export async function connectTelegramPolling(options) {
    if (!/^[1-9]\d*$/.test(options.botId) || !options.ownerId)
        throw new Error('Telegram Gateway 身份无效');
    const cancel = new AbortController();
    const signal = AbortSignal.any([options.signal, cancel.signal]);
    const sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
    const call = (method, payload, timeoutMs) => options.api.call(options.token, method, { payload, timeoutMs, signal });
    let info;
    try {
        signal.throwIfAborted();
        info = await verifyTelegramBotIdentity(call, options.expectedPlatformBotId);
        if (info.webhookUrl.trim()) {
            options.onPollStatus?.('conflict');
            throw new Error('Telegram Webhook 与长轮询冲突');
        }
        signal.throwIfAborted();
    }
    catch {
        try {
            await options.api.close();
        }
        catch {
            throw new GatewayConnectionCleanupError();
        }
        throw new Error('Telegram Gateway 启动失败');
    }
    const botPlatformId = String(info.id);
    const botUsername = typeof info.username === 'string' ? info.username : '';
    async function poll() {
        let backoff = 1_000;
        try {
            while (!signal.aborted) {
                try {
                    const cursor = await options.inbox.cursor();
                    const payload = { timeout: 50, allowed_updates: ['message', 'callback_query'] };
                    if (cursor !== null) {
                        if (!Number.isSafeInteger(cursor + 1))
                            throw new Error('Telegram 游标越界');
                        payload.offset = cursor + 1;
                    }
                    const updates = await call('getUpdates', payload, 60_000);
                    if (!Array.isArray(updates))
                        throw new Error('Telegram 更新格式无效');
                    options.onPollStatus?.('ready');
                    backoff = 1_000;
                    const ordered = updates.filter(object);
                    if (ordered.some(value => typeof value.update_id !== 'number' || !Number.isSafeInteger(value.update_id) || value.update_id < 0))
                        throw new Error('Telegram 事件 ID 无效');
                    ordered.sort((a, b) => Number(a.update_id) - Number(b.update_id));
                    for (const update of ordered) {
                        signal.throwIfAborted();
                        const id = update.update_id;
                        if (object(update.callback_query)) {
                            if (!await options.callback(update.callback_query, signal)) {
                                await sleep(backoff, signal);
                                backoff = Math.min(backoff * 2, 60_000);
                                break;
                            }
                            await options.inbox.commit(id, null);
                            continue;
                        }
                        // 编辑消息、channel_post 等不能重新触发 Agent/有副作用工具。
                        if (!object(update.message)) {
                            await options.inbox.commit(id, null);
                            continue;
                        }
                        const message = normalizeTelegramMessage(update, {
                            botId: options.botId, ownerId: options.ownerId, botPlatformId, botUsername,
                        });
                        const result = message ? await options.preflight(message, signal) : 'enqueue';
                        if (result !== 'enqueue' && result !== 'consumed')
                            throw new Error('Telegram 入站预检结果无效');
                        const consumed = result === 'consumed';
                        let ready = consumed ? null : message;
                        if (message && !consumed) {
                            if (options.materialize)
                                ready = await options.materialize(structuredClone(message), signal);
                            else if (message.attachments.length || message.quoted_attachments.length)
                                throw new Error('Telegram 媒体暂存服务未配置');
                            if (ready) {
                                if (['platform', 'owner_user_id', 'bot_id', 'channel_id', 'chat_type', 'chat_id', 'platform_user_id', 'message_id'].some(key => ready[key] !== message[key])
                                    || !Array.isArray(ready.attachments) || ready.attachments.some(id => typeof id !== 'string' || !id)
                                    || ready.quoted_attachments !== undefined && (!Array.isArray(ready.quoted_attachments) || ready.quoted_attachments.length > 0))
                                    throw new Error('Telegram 媒体暂存结果无效');
                            }
                        }
                        signal.throwIfAborted();
                        await options.inbox.commit(id, ready);
                    }
                }
                catch (error) {
                    if (signal.aborted)
                        return;
                    options.onPollStatus?.(error instanceof TelegramApiError &&
                        (error.statusCode === 409 || error.errorCode === 409) ? 'conflict' : 'retrying');
                    options.report?.('poll-unavailable', error);
                    // 平台 429 只读取受限数字，不暴露任何上游正文或请求 URL。
                    const retryAfter = object(error) && typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter)
                        ? error.retryAfter * 1_000 : backoff;
                    await sleep(Math.max(1_000, Math.min(retryAfter, 300_000)), signal);
                    backoff = Math.min(backoff * 2, 60_000);
                }
            }
        }
        catch (error) {
            if (!signal.aborted)
                throw error;
        }
        finally {
            await options.api.close();
        }
    }
    const closed = poll();
    // 监督器稍后注册观察者；提前安装拒绝处理，避免启动/取消竞态的未处理拒绝。
    void closed.catch(() => undefined);
    return { closed, async stop() { cancel.abort(); await closed; } };
}
