const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const truthy = (value) => Array.isArray(value) ? value.length > 0 : object(value) ? Object.keys(value).length > 0 : Boolean(value);
const first = (...values) => values.find(truthy);
const string = (value) => value === null || value === undefined ? 'None' : String(value);
const usernameOf = (value) => value.replace(/^@+/, '').toLowerCase();
const textOf = (message) => String(first(message.text, message.caption) ?? '');
const entitiesOf = (message) => first(message.entities, message.caption_entities);
function integer(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? Math.trunc(value) : null;
    if (typeof value === 'boolean')
        return Number(value);
    if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value.trim()))
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}
/** Telegram 偏移是 UTF-16；非法半个 surrogate 的位置与 Python 一致向后取整。 */
function utf16Boundary(text, offset) {
    let position = 0;
    for (const character of text) {
        if (position >= offset)
            break;
        position += character.length;
    }
    return position;
}
export function telegramEntityText(text, entity) {
    const offset = integer(entity.offset ?? 0), length = integer(entity.length ?? 0);
    if (offset === null || length === null)
        return '';
    const start = Math.max(0, offset);
    return text.slice(utf16Boundary(text, start), utf16Boundary(text, start + Math.max(0, length)));
}
export function normalizeTelegramCommand(text, entities, botUsername) {
    for (const entity of entities) {
        if (!object(entity) || entity.type !== 'bot_command')
            continue;
        const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/.exec(telegramEntityText(text, entity));
        if (!match || match[2] && match[2].toLowerCase() !== usernameOf(botUsername))
            return null;
        const end = (integer(entity.offset ?? 0) ?? 0) + (integer(entity.length ?? 0) ?? 0);
        return [match[1].toLowerCase(), text.slice(utf16Boundary(text, end)).trim()];
    }
    const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+|$)/.exec(text);
    if (!match || match[2] && match[2].toLowerCase() !== usernameOf(botUsername))
        return null;
    return [match[1].toLowerCase(), text.slice(match[0].length).trim()];
}
function mediaItem(message) {
    if (Array.isArray(message.photo)) {
        const photos = message.photo.filter((item) => object(item) && truthy(item.file_id));
        const size = (item) => typeof item.file_size === 'number' && Number.isInteger(item.file_size) ? item.file_size : 0;
        const selected = photos.reduce((best, item) => !best || size(item) > size(best) ? item : best, undefined);
        if (selected)
            return { file_id: selected.file_id, file_size: selected.file_size ?? null, file_name: '图片.jpg', mime_type: 'image/jpeg', media_type: 'photo' };
    }
    for (const [field, name, mime] of [
        ['document', '文件', 'application/octet-stream'], ['audio', '音频', 'audio/mpeg'],
        ['voice', '语音.ogg', 'audio/ogg'], ['video', '视频.mp4', 'video/mp4'],
        ['animation', '动画.mp4', 'video/mp4'], ['video_note', '视频消息.mp4', 'video/mp4'],
    ]) {
        const item = message[field];
        if (object(item) && truthy(item.file_id))
            return { file_id: item.file_id, file_size: item.file_size ?? null, file_name: String(first(item.file_name, name)), mime_type: String(first(item.mime_type, mime)), media_type: field };
    }
    return null;
}
function nativeMentioned(message, botId, botUsername) {
    const entities = entitiesOf(message), username = usernameOf(botUsername), text = textOf(message);
    for (const entity of Array.isArray(entities) ? entities : []) {
        if (!object(entity))
            continue;
        if (entity.type === 'text_mention' && object(entity.user) && string(entity.user.id) === botId)
            return true;
        if (entity.type === 'mention' && username && usernameOf(telegramEntityText(text, entity)) === username)
            return true;
        if (entity.type === 'bot_command') {
            const match = /^\/[^@\s]+@([A-Za-z0-9_]+)$/.exec(telegramEntityText(text, entity));
            if (!match || username && match[1].toLowerCase() === username)
                return true;
        }
    }
    return false;
}
function otherMentionFacts(message, botId, botUsername) {
    const entities = entitiesOf(message), text = textOf(message), username = usernameOf(botUsername);
    if (!Array.isArray(entities))
        return [null, null];
    let other = false, bot = false, recognized = false, unresolved = false;
    for (const entity of entities) {
        if (!object(entity))
            continue;
        if (entity.type === 'text_mention' && object(entity.user) && entity.user.id != null) {
            recognized = true;
            if (string(entity.user.id) !== botId) {
                other = true;
                bot ||= entity.user.is_bot === true;
            }
        }
        else if (entity.type === 'mention') {
            const target = usernameOf(telegramEntityText(text, entity));
            if (!target)
                continue;
            recognized = true;
            if (!username || target !== username)
                unresolved = true;
        }
        else if (entity.type === 'bot_command') {
            const match = /^\/[^@\s]+@([A-Za-z0-9_]+)$/.exec(telegramEntityText(text, entity));
            if (match) {
                recognized = true;
                if (username && match[1].toLowerCase() !== username) {
                    other = true;
                    bot = true;
                }
            }
        }
    }
    return unresolved ? [other || null, bot || null] : [recognized ? other : null, recognized ? bot : null];
}
function attentionMentionFacts(message, botId, botUsername) {
    const entities = message.entities ?? message.caption_entities, text = textOf(message), username = usernameOf(botUsername);
    const unresolvedText = /(?<![A-Za-z0-9_])@[A-Za-z0-9_]+/.test(text);
    if (!Array.isArray(entities))
        return [unresolvedText ? null : false, null, null, unresolvedText];
    let current = false, otherBot = false, otherMember = false, unresolved = false;
    for (const entity of entities) {
        if (!object(entity)) {
            unresolved = true;
            continue;
        }
        if (entity.type === 'text_mention') {
            if (!object(entity.user) || entity.user.id == null) {
                unresolved = true;
                continue;
            }
            if (string(entity.user.id) === botId)
                current = true;
            else {
                otherMember = true;
                otherBot ||= entity.user.is_bot === true;
            }
        }
        else if (entity.type === 'mention') {
            const target = usernameOf(telegramEntityText(text, entity));
            if (target && username && target === username)
                current = true;
            else
                unresolved = true;
        }
        else if (entity.type === 'bot_command') {
            const match = /^\/[^@\s]+@([A-Za-z0-9_]+)$/.exec(telegramEntityText(text, entity));
            if (match && username && match[1].toLowerCase() !== username)
                otherBot = true;
        }
    }
    return unresolved ? [current || null, otherBot || null, otherMember || null, true] : [current, otherBot, otherMember, false];
}
/** 保留 Python parser 的 edited_message 兼容；轮询入口必须另行拒绝编辑事件。 */
export function normalizeTelegramMessage(update, options) {
    const message = first(update.message, update.edited_message);
    if (!object(message) || !object(message.chat) || !object(message.from))
        return null;
    const chat = message.chat, sender = message.from;
    if (truthy(sender.is_bot) || sender.id == null)
        return null;
    const media = mediaItem(message), rawText = first(message.text, message.caption) ?? '', text = typeof rawText === 'string' ? rawText : '';
    if (!text.trim() && !media || !['private', 'group', 'supergroup'].includes(String(chat.type)))
        return null;
    const entities = entitiesOf(message);
    const command = typeof message.text === 'string' ? normalizeTelegramCommand(text, Array.isArray(entities) ? entities : [], options.botUsername) : null;
    if (text.trimStart().startsWith('/') && command === null)
        return null;
    const username = options.botUsername.trim().replace(/^@+/, '');
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const content = command ? `/${command[0]} ${command[1]}`.trim() : username ? text.replace(new RegExp(`(?<![A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, 'gi'), '@咕咕') : text;
    const botPlatformId = options.botPlatformId ?? '', native = nativeMentioned(message, botPlatformId, options.botUsername);
    const candidate = object(message.reply_to_message) ? message.reply_to_message : null;
    const reply = candidate && (candidate.chat === undefined || object(candidate.chat) && string(candidate.chat.id) === string(chat.id))
        ? candidate : null;
    const replySender = reply && object(reply.from) ? reply.from : null;
    const mentioned = native || command !== null || !!(replySender && string(replySender.id) === botPlatformId);
    const other = otherMentionFacts(message, botPlatformId, options.botUsername), attention = attentionMentionFacts(message, botPlatformId, options.botUsername);
    const chatId = String(first(chat.id) ?? ''), messageId = String(first(message.message_id) ?? '');
    const key = (id) => `${options.botId}:${chatId}:${string(id)}`;
    const quotedMedia = reply ? mediaItem(reply) : null;
    let quotedText = reply ? textOf(reply).trim() : '';
    if (!quotedText && quotedMedia)
        quotedText = `[${quotedMedia.media_type} 附件]`;
    const replyId = reply?.message_id != null ? string(reply.message_id) : null;
    const firstName = String(first(sender.first_name) ?? '').trim(), lastName = String(first(sender.last_name) ?? '').trim();
    return {
        platform: 'telegram', channel_id: options.botId, bot_id: options.botId, owner_user_id: options.ownerId,
        chat_type: chat.type === 'private' ? 'c2c' : 'group', chat_id: chatId, platform_user_id: string(sender.id),
        platform_user_name: [firstName, lastName].filter(Boolean).join(' ') || (sender.username ? `@${string(sender.username)}` : null),
        message_id: messageId, platform_message_id: messageId, platform_event_id: String(first(update.update_id) ?? ''), text: content, attention_raw_text: text,
        attachments: media ? [{ ...media, source_attachment_index: 0 }] : [],
        quoted_attachments: quotedMedia && replyId !== null ? [{ ...quotedMedia, source_platform_message_id: key(replyId), source_attachment_index: 0 }] : [],
        attachment_source_message_id: media && message.message_id != null ? key(message.message_id) : null,
        bot_mentioned: mentioned, native_bot_mentioned: native || command !== null ? true : attention[0],
        mentions_other_member: attention[2] ?? other[0], mentions_other_bot: attention[1] ?? other[1], has_unresolved_mention: attention[3],
        group_mentioned: chat.type !== 'private' && mentioned, reply_to_message_id: replyId, reply_to_platform_message_id: replyId,
        reply_target_sender_id: replySender?.id != null ? string(replySender.id) : null,
        reply_target_is_bot: typeof replySender?.is_bot === 'boolean' ? replySender.is_bot : null,
        platform_sent_ms: typeof message.date === 'number' && message.date > 0 && Number.isFinite(message.date) ? Math.trunc(message.date * 1000) : null,
        sender_is_bot: false, quoted_text: [...quotedText].slice(0, 2000).join('') || null,
        telegram_command: command?.[0] ?? null, received_at: message.date ?? null,
    };
}
