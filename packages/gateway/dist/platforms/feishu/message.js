import { asciiDecimalDigits } from '@gugu/core/shared/unicode-decimal';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid() { throw new TypeError('飞书事件格式无效'); }
function string(value) {
    if (value === null || value === undefined)
        return '';
    if (typeof value !== 'string')
        return invalid();
    return value;
}
function integer(value) {
    if (typeof value === 'number')
        return Number.isSafeInteger(Math.trunc(value)) ? Math.trunc(value) : null;
    if (typeof value !== 'string')
        return null;
    const normalized = asciiDecimalDigits(value.trim());
    if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
        return null;
    const parsed = Number(normalized.replaceAll('_', ''));
    return Number.isSafeInteger(parsed) ? parsed : null;
}
function content(raw) {
    if (!raw)
        return {};
    if (typeof raw !== 'string')
        return invalid();
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
/** 与Python一致递归兼容旧卡片和CardKit2.0，仅抽取markdown/text可读节点。 */
export function extractFeishuCardText(value) {
    const parts = [];
    let nodes = 0;
    function collect(current, depth) {
        if (++nodes > 10000 || depth > 64)
            return invalid();
        if (Array.isArray(current)) {
            for (const item of current)
                collect(item, depth + 1);
            return;
        }
        if (!object(current))
            return;
        if (current.tag === 'markdown' || current.tag === 'text') {
            const text = string(current.content || current.text || '');
            if (text)
                parts.push(text);
        }
        else
            for (const child of Object.values(current))
                collect(child, depth + 1);
    }
    collect(value, 0);
    return parts.join('\n').trim();
}
/** 仅处理Host实际查询到的message item；不会按parent_id猜测内容或读取网络。 */
export function parseFeishuQuoteFacts(message, botOpenId) {
    if (!object(message))
        return { text: null, sender_id: null, sender_is_bot: null, platform_sent_ms: null };
    const sender = object(message.sender) && object(message.sender.sender_id) ? message.sender.sender_id : {};
    const senderId = string(sender.open_id) || null;
    const timestamp = integer(message.create_time);
    const facts = { text: null, sender_id: senderId, sender_is_bot: senderId && botOpenId ? senderId === botOpenId : null, platform_sent_ms: timestamp !== null && timestamp > 0 ? timestamp : null };
    if (message.msg_type === 'text' || message.msg_type === 'interactive') {
        const body = object(message.body) ? content(message.body.content) : {};
        if (body === undefined)
            facts.text = '[解析失败]';
        else if (message.msg_type === 'interactive')
            facts.text = extractFeishuCardText(body) || '[空消息]';
        else {
            if (!object(body))
                return invalid();
            facts.text = string(body.text).trim() || '[空消息]';
        }
    }
    else {
        const placeholders = { post: '[图文消息]', image: '[图片消息]', file: '[文件消息]', audio: '[语音消息]', media: '[视频消息]' };
        facts.text = placeholders[string(message.msg_type)] || '[非文字消息]';
    }
    return facts;
}
function mentionFacts(mentions, botOpenId) {
    if (!Array.isArray(mentions))
        return { current: null, otherBot: null, otherMember: null, unresolved: false, botMentioned: false };
    if (!mentions.length)
        return { current: false, otherBot: false, otherMember: false, unresolved: false, botMentioned: false };
    if (!botOpenId)
        return { current: null, otherBot: null, otherMember: null, unresolved: true, botMentioned: false };
    let current = false, otherBot = false, otherMember = false, unresolved = false;
    for (const mention of mentions) {
        const target = object(mention) ? mention.id : null;
        const candidate = object(target) ? target.open_id : typeof target === 'string' ? target : null;
        if (!candidate) {
            unresolved = true;
            continue;
        }
        if (candidate === botOpenId)
            current = true;
        else {
            otherMember = true;
            if (object(mention) && mention.is_bot === true)
                otherBot = true;
        }
    }
    return { current: current || !unresolved ? current : null, otherBot: otherBot || !unresolved ? otherBot : null,
        otherMember: otherMember || !unresolved ? otherMember : null, unresolved, botMentioned: current };
}
function resolveMentions(body, mentions) {
    if (!Array.isArray(mentions))
        return body;
    for (const item of mentions)
        if (object(item) && typeof item.key === 'string' && item.key && typeof item.name === 'string' && item.name)
            body = body.split(item.key).join(`@${item.name.replace(/^[@＠]+/u, '')}`);
    return body;
}
/** Host验证WebSocket/签名来源后调用；不创建网络、读取配置、下载资源或伪造引用。 */
export function parseFeishuEvent(raw, options) {
    if (!options.botId || !options.ownerId || !options.appId || !Number.isSafeInteger(options.nowMs) || options.nowMs < 0)
        return invalid();
    if (!object(raw) || !object(raw.event))
        return null;
    const header = object(raw.header) ? raw.header : {}, event = raw.event;
    if (header.app_id && header.app_id !== options.appId)
        return null;
    const eventType = header.event_type;
    if (eventType === 'card.action.trigger' || eventType === undefined && object(event.action)) {
        if (!object(event.action) || !object(event.action.value) || !object(event.operator))
            return null;
        const value = event.action.value, promptId = typeof value.prompt_id === 'number' && !Number.isSafeInteger(value.prompt_id) ? null : integer(value.prompt_id), operatorId = string(event.operator.open_id);
        if (promptId === null || promptId <= 0 || !operatorId || typeof value.token !== 'string' || !value.token)
            return null;
        return { kind: 'card_action', ownerId: options.ownerId, botId: options.botId, eventId: string(header.event_id) || null, operatorId,
            promptId, actionToken: value.token, optionId: typeof value.option_id === 'string' ? Array.from(value.option_id.trim()).slice(0, 64).join('') : '',
            label: typeof value.label === 'string' ? Array.from(value.label.trim()).slice(0, 120).join('') : '' };
    }
    if (eventType !== undefined && eventType !== 'im.message.receive_v1')
        return null;
    const created = integer(header.create_time);
    if (created !== null && options.nowMs - created > 20000)
        return null;
    if (!object(event.message))
        return null;
    const message = event.message, messageType = message.message_type;
    if (!['text', 'post', 'interactive', 'image', 'file', 'audio', 'media'].includes(String(messageType)))
        return null;
    const sender = object(event.sender) ? event.sender : {}, senderId = object(sender.sender_id) ? string(sender.sender_id.open_id) : '';
    const messageId = string(message.message_id), chatId = string(message.chat_id);
    if (!senderId || !messageId || !chatId)
        return null;
    const body = content(message.content);
    const chatType = message.chat_type === 'group' ? 'group' : 'c2c';
    let text = '', preflightText = '';
    const mediaItems = [];
    function media(resourceKey, resourceType, fileName, source, isVoice = false) {
        mediaItems.push({ messageId, resourceKey: string(resourceKey), resourceType, fileName, source, isVoice });
    }
    if (messageType === 'text') {
        if (body !== undefined && !object(body))
            return invalid();
        text = body === undefined ? '' : string(body.text).trim();
        preflightText = text;
    }
    else if (messageType === 'interactive')
        text = body === undefined ? '[卡片消息，解析失败]' : extractFeishuCardText(body) || '[卡片消息]';
    else {
        if (body !== undefined && !object(body))
            return invalid();
        const c = body ?? {};
        if (messageType === 'post') {
            const lines = [], title = string(c.title).trim();
            for (const row of Array.isArray(c.content) ? c.content : []) {
                if (!Array.isArray(row))
                    continue;
                const parts = [];
                for (const item of row) {
                    if (!object(item))
                        continue;
                    if (item.tag === 'text')
                        parts.push(string(item.text));
                    else if (item.tag === 'a')
                        parts.push(string(item.text || item.href));
                    else if (item.tag === 'at')
                        parts.push(`@${string(item.user_name || item.user_id)}`);
                    else if (item.tag === 'img' && item.image_key)
                        media(item.image_key, 'image', '图片.jpg', 'post');
                    else if (item.tag === 'media' && item.file_key)
                        media(item.file_key, 'file', '视频.mp4', 'post');
                }
                if (parts.length)
                    lines.push(parts.join(''));
            }
            text = [title, lines.join('\n').trim()].filter(Boolean).join('\n').trim();
        }
        else if (messageType === 'image')
            media(c.image_key, 'image', '图片.jpg', 'message');
        else if (messageType === 'audio')
            media(c.file_key, 'file', '语音.opus', 'message', true);
        else if (messageType === 'media')
            media(c.file_key, 'file', '视频.mp4', 'message');
        else
            media(c.file_key, 'file', string(c.file_name) || '文件', 'message');
    }
    if (!text && !mediaItems.length)
        return null;
    const mentions = mentionFacts(message.mentions, options.botOpenId), parentId = string(message.parent_id) || null, sent = integer(message.create_time);
    const payload = { platform: 'feishu', channel_id: options.botId, bot_id: options.botId, owner_user_id: options.ownerId,
        platform_user_id: senderId, chat_id: chatId, chat_type: chatType, message_id: messageId, platform_message_id: messageId,
        platform_sent_ms: sent !== null && sent > 0 ? sent : null, text: resolveMentions(text, message.mentions), attention_raw_text: text,
        quoted_text: null, reply_to_platform_message_id: parentId, reply_target_sender_id: null, reply_target_is_bot: null,
        sender_is_bot: sender.sender_type === 'app' ? true : sender.sender_type === 'user' ? false : null,
        native_bot_mentioned: mentions.current, mentions_other_bot: mentions.otherBot, mentions_other_member: mentions.otherMember,
        has_unresolved_mention: mentions.unresolved, bot_mentioned: mentions.botMentioned, group_mentioned: mentions.botMentioned,
        processable_media: false, attachments: [] };
    return { kind: 'message', payload, mediaItems, quoteRequest: parentId ? { messageId: parentId, cardContentType: 'user_card_content' } : null,
        preflight: { platform: 'feishu', channel_id: options.botId, owner_user_id: options.ownerId, platform_user_id: senderId,
            chat_id: chatType === 'group' ? chatId : null, chat_type: chatType, message_id: messageId, text: preflightText,
            attachments: messageType === 'text' ? [] : [{ pending_media: true }] } };
}
