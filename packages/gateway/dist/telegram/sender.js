import { setTimeout as delay } from 'node:timers/promises';
import { splitMarkdownV2 as splitTelegramMarkdownV2 } from '@gugu/core/im/telegram-format';
import { TelegramApiError } from './client.js';
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** 每 Bot 一个实例，跨 chat 串行维护 bot/chat 限速；未知结果不自动重试。 */
export function createTelegramSender(options) {
    const now = options.now ?? (() => performance.now());
    const sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
    const nextChat = new Map();
    let nextBot = 0;
    let tail = Promise.resolve();
    function serialize(work) {
        const result = tail.then(work);
        tail = result.catch(() => undefined);
        return result;
    }
    function checkTarget(target) {
        if (!/^-?[1-9]\d*$/.test(target.chatId) || !['c2c', 'group'].includes(target.chatType)
            || (target.replyToMessageId !== undefined && (!/^[1-9]\d*$/.test(target.replyToMessageId)
                || !Number.isSafeInteger(Number(target.replyToMessageId)))))
            throw new Error('Telegram 投递目标无效');
    }
    async function call(target, method, payload, signal, files, authorize) {
        const interval = target.chatType === 'group' ? 3_000 : 1_000;
        for (let attempt = 0; attempt < 3; attempt++) {
            signal?.throwIfAborted();
            const wait = Math.max((nextChat.get(target.chatId) ?? 0) - now(), nextBot - now());
            if (wait > 0)
                await sleep(wait, signal);
            if (authorize && !await authorize())
                throw new Error('Telegram 投递授权已撤销');
            try {
                const result = await options.api.call(options.token, method, { payload, files, signal, authorize });
                const completed = now();
                nextChat.set(target.chatId, completed + interval);
                nextBot = completed + 1_000 / 30;
                return result;
            }
            catch (error) {
                if (!(error instanceof TelegramApiError) || error.errorCode !== 429
                    || !error.retryAfter || error.retryAfter < 0 || attempt === 2)
                    throw error;
                const until = now() + Math.max(error.retryAfter * 1_000, interval);
                nextChat.set(target.chatId, until);
                nextBot = until;
            }
        }
        throw new Error('Telegram 投递重试耗尽');
    }
    function resultId(result) {
        return object(result) && (typeof result.message_id === 'string' || typeof result.message_id === 'number')
            && /^[1-9]\d*$/.test(String(result.message_id)) ? String(result.message_id) : null;
    }
    function failure(error, ids) {
        const rejected = !ids.length && error instanceof TelegramApiError
            && error.statusCode !== undefined && error.statusCode >= 300 && error.statusCode < 500;
        return { outcome: rejected ? 'rejected' : 'unknown', platformMessageIds: ids };
    }
    const sender = {
        text(target, text, args = {}) {
            return serialize(async () => {
                checkTarget(target);
                const chunks = splitTelegramMarkdownV2(text);
                if (!chunks.length)
                    return { outcome: 'rejected', platformMessageIds: [] };
                const ids = [];
                try {
                    for (let index = 0; index < chunks.length; index++) {
                        const payload = { chat_id: target.chatId, text: chunks[index], parse_mode: 'MarkdownV2' };
                        if (index === 0 && target.replyToMessageId)
                            payload.reply_to_message_id = Number(target.replyToMessageId);
                        if (index === chunks.length - 1 && args.replyMarkup)
                            payload.reply_markup = args.replyMarkup;
                        const id = resultId(await call(target, 'sendMessage', payload, args.signal, undefined, args.authorize));
                        if (!id)
                            return { outcome: 'unknown', platformMessageIds: ids };
                        ids.push(id);
                    }
                    return { outcome: 'accepted', platformMessageIds: ids };
                }
                catch (error) {
                    return failure(error, ids);
                }
            });
        },
        interaction(target, prompt, signal, authorize) {
            if (!Number.isSafeInteger(prompt.prompt_id) || prompt.prompt_id < 1 || (prompt.options?.length ?? 0) > 8)
                return Promise.resolve({ outcome: 'rejected', platformMessageIds: [] });
            const buttons = (prompt.options ?? []).filter(option => option.token).map(option => ({ text: Array.from(option.label || option.id || '选择').slice(0, 64).join(''), callback_data: `${prompt.prompt_id}:${option.token}` }));
            if (buttons.some(button => Buffer.byteLength(button.callback_data) > 64 || button.callback_data.slice(button.callback_data.indexOf(':') + 1).includes(':')))
                return Promise.resolve({ outcome: 'rejected', platformMessageIds: [] });
            const rows = [];
            for (let i = 0; i < buttons.length; i += 4)
                rows.push(buttons.slice(i, i + 4));
            return sender.text(target, [prompt.title || '需要你的回答', prompt.body || ''].filter(Boolean).join('\n'), { signal, authorize, ...(buttons.length ? { replyMarkup: { inline_keyboard: rows } } : {}) });
        },
        file(target, data, filename, signal, authorize) {
            return serialize(async () => {
                checkTarget(target);
                if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > 50_000_000)
                    return { outcome: 'rejected', platformMessageIds: [] };
                const name = Array.from(filename.replace(/\\/g, '/').split('/').at(-1) || '附件').slice(0, 180).join('').replace(/[\r\n\0"]/g, '_');
                const ext = name.split('.').at(-1)?.toLowerCase();
                const photo = ['jpg', 'jpeg', 'png'].includes(ext ?? '') && data.byteLength <= 10_000_000;
                const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
                const payload = { chat_id: target.chatId };
                if (target.replyToMessageId)
                    payload.reply_to_message_id = Number(target.replyToMessageId);
                try {
                    let result;
                    try {
                        result = await call(target, photo ? 'sendPhoto' : 'sendDocument', payload, signal, { [photo ? 'photo' : 'document']: { name, data, contentType: mime } }, authorize);
                    }
                    catch (error) {
                        if (!photo || !(error instanceof TelegramApiError) || error.errorCode !== 400)
                            throw error;
                        result = await call(target, 'sendDocument', { chat_id: target.chatId }, signal, { document: { name, data, contentType: mime } }, authorize);
                    }
                    const id = resultId(result);
                    return { outcome: id ? 'accepted' : 'unknown', platformMessageIds: id ? [id] : [] };
                }
                catch (error) {
                    return failure(error, []);
                }
            });
        },
        draft(target, text, draftId, signal, authorize) {
            return serialize(async () => {
                checkTarget(target);
                if (target.chatType !== 'c2c' || !Number.isSafeInteger(draftId) || !draftId)
                    return false;
                let preview = text.slice(0, 4096);
                if (/[\uD800-\uDBFF]$/.test(preview))
                    preview = preview.slice(0, -1);
                try {
                    await call(target, 'sendMessageDraft', { chat_id: target.chatId, draft_id: draftId, text: preview }, signal, undefined, authorize);
                    return true;
                }
                catch {
                    return false;
                }
            });
        },
        async drain() { await tail; },
    };
    return sender;
}
