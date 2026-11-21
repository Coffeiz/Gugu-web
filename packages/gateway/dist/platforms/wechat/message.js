import { asciiDecimalDigits } from '@gugu/core/shared/unicode-decimal';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const truthy = (value) => object(value) ? Object.keys(value).length > 0 : Array.isArray(value) ? value.length > 0 : Boolean(value);
function text(value) {
    if (value === undefined || value === null)
        return '';
    if (typeof value !== 'string')
        throw new TypeError('微信消息文本格式无效');
    return value;
}
function field(item, name) {
    const value = item[name];
    if (value === undefined || value === null)
        return {};
    if (!object(value))
        throw new TypeError('微信消息项目格式无效');
    return value;
}
/** iLink通常不给引用原文；保留旧占位，不凭msg_id猜测原文或扩展文件/视频下载。 */
export function extractWechatQuote(refMessage) {
    if (!object(refMessage))
        return { quotedText: null, mediaItems: [] };
    const title = text(refMessage.title).trim();
    const item = refMessage.message_item;
    if (!object(item))
        return { quotedText: title || null, mediaItems: [] };
    const body = text(field(item, 'text_item').text).trim();
    if (body)
        return { quotedText: body, mediaItems: [] };
    if (item.type === 3 || truthy(item.voice_item))
        return { quotedText: text(field(item, 'voice_item').text).trim() || '[语音消息]', mediaItems: [] };
    if (item.type === 2 || truthy(item.image_item))
        return { quotedText: '[图片消息]', mediaItems: [{ type: 2, image_item: field(item, 'image_item') }] };
    if (item.type === 4 || truthy(item.file_item))
        return { quotedText: '[文件消息]', mediaItems: [] };
    if (item.type === 5 || truthy(item.video_item))
        return { quotedText: '[视频消息]', mediaItems: [] };
    return { quotedText: title || '[微信暂不支持消息引用识别]', mediaItems: [] };
}
/** 保留Python int转换语义；超出JS精确整数范围的值拒绝用作消息顺序。 */
export function wechatPlatformSentMs(message) {
    const value = message.create_time_ms;
    if (typeof value !== 'number' && typeof value !== 'string')
        return null;
    let parsed;
    if (typeof value === 'number')
        parsed = Math.trunc(value);
    else {
        const normalized = asciiDecimalDigits(value.trim());
        if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
            return null;
        parsed = Number(normalized.replaceAll('_', ''));
    }
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
/**
 * 只解析用户→Bot消息。凭据预检、媒体、typing和入队由Host按该顺序执行。
 * Host在预检通过后处理mediaItems，只有unsupported媒体且无正文时不得启动Agent。
 */
export function parseWechatMessage(message, options) {
    if (!object(message) || message.message_type !== 1)
        return null;
    if (!options.botId || !options.ownerId)
        throw new TypeError('微信Bot身份未配置');
    const sender = text(message.from_user_id);
    if (!sender)
        return null;
    const contextToken = text(message.context_token), groupId = text(message.group_id);
    const nativeId = message.message_id;
    const eventId = typeof nativeId === 'number' && Number.isSafeInteger(nativeId) && nativeId > 0
        ? `message:${nativeId}` : undefined;
    const rawItems = message.item_list ?? [];
    if (!Array.isArray(rawItems) || rawItems.some(item => !object(item)))
        throw new TypeError('微信消息项目列表无效');
    const items = rawItems;
    let body = items.map(item => text(field(item, 'text_item').text)).join('').trim();
    const transcripts = items.filter(item => item.type === 3).map(item => text(field(item, 'voice_item').text).trim());
    const voices = transcripts.map(transcript => transcript
        ? `🎤 用户发来一条语音（已转文字）：「${transcript}」。请直接听懂这段话并自然回应——这是对话内容，不是文件，别问「要不要保存」这类话。`
        : '🎤 用户发来一条语音，但转写失败/没听清，麻烦让用户用文字重新说一下。');
    const onlyMissingTranscripts = !body && transcripts.length > 0 && transcripts.every(transcript => !transcript);
    if (voices.length)
        body = (body ? body + '\n\n' : '') + voices.join('\n\n');
    const nonText = items.filter(item => item.type !== 1 && item.type !== 3);
    // 与Python一致：空正文/无当前媒体在引用解析之前早退，不能只凭引用启动Agent。
    if (!body && !nonText.length)
        return null;
    let quote = { quotedText: null, mediaItems: [] };
    for (const item of items) {
        const candidate = extractWechatQuote(item.ref_msg);
        if (candidate.quotedText || candidate.mediaItems.length) {
            quote = candidate;
            break;
        }
    }
    const requirement = (item, source) => ({
        source, kind: truthy(item.image_item) ? 'image' : 'unsupported', item: structuredClone(item),
    });
    return {
        payload: { platform: 'wechat', channel_id: options.botId, bot_id: options.botId, owner_user_id: options.ownerId,
            platform_user_id: sender, message_id: contextToken, ...(eventId ? { platform_event_id: eventId } : {}), context_token: contextToken, platform_sent_ms: wechatPlatformSentMs(message),
            chat_type: groupId ? 'group' : 'c2c', ...(groupId ? { chat_id: groupId } : {}), wechat_group_id: groupId,
            text: body, quoted_text: quote.quotedText, attachments: [] },
        mediaItems: [...nonText.map(item => requirement(item, 'message')), ...quote.mediaItems.map(item => requirement(item, 'quote'))],
        hasQuote: !!quote.quotedText || quote.mediaItems.length > 0,
        ...(onlyMissingTranscripts && nonText.length === 0 ? { voiceTranscriptionMissing: true } : {}),
    };
}
export const WECHAT_MISSING_VOICE_NOTICE = '没收到这条语音的转写，请重发语音或改用文字。';
