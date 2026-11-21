import { z } from 'zod';
const conversationScope = z.object({
    ownerId: z.string().min(1),
    botId: z.string().min(1),
    platform: z.enum(['feishu', 'qq', 'wechat', 'telegram']),
    platformUserId: z.string().min(1),
});
const receivedMessage = z.object({
    version: z.literal(1),
    kind: z.literal('message.received'),
    scope: z.discriminatedUnion('chatType', [
        conversationScope.extend({ chatType: z.literal('c2c'), chatId: z.null() }),
        conversationScope.extend({ chatType: z.literal('group'), chatId: z.string().min(1) }),
    ]),
    eventId: z.string().min(1),
    platformMessageId: z.string().optional(),
    platformUserName: z.string().max(256).optional(),
    text: z.string(),
    quotedText: z.string().nullable(),
    botMentioned: z.boolean(),
});
/** 重新读取序列化事件时，核对完整结构和可信连接归属。 */
export function parseImReceivedMessage(connection, value) {
    const result = receivedMessage.safeParse(value);
    if (!result.success)
        throw new Error('IM 入站事件格式无效');
    const event = result.data;
    if (event.scope.ownerId !== connection.ownerId || event.scope.botId !== connection.botId
        || event.scope.platform !== connection.platform)
        throw new Error('IM 入站事件与连接范围不匹配');
    return Object.freeze({ ...event, scope: Object.freeze(event.scope) });
}
/** 连接身份由宿主提供，平台载荷仅用于核对来源和提取会话事实。 */
export function readImConversationScope(connection, payload) {
    const { chat_type: chatType, chat_id: chat, platform_user_id: sender } = payload;
    if (!connection.ownerId || !connection.botId
        || payload.platform !== connection.platform || payload.owner_user_id !== connection.ownerId
        || payload.bot_id !== connection.botId || payload.channel_id !== connection.botId
        || (chatType !== 'group' && chatType !== 'c2c') || typeof sender !== 'string' || !sender
        || (chatType === 'group' && (typeof chat !== 'string' || !chat)))
        throw new Error('IM 入站事件与连接范围不匹配');
    return Object.freeze({ ...connection, chatType, chatId: chatType === 'group' ? chat : null, platformUserId: sender });
}
/** 微信会话令牌只用于回复，去重优先使用平台消息身份。 */
export function wechatEventId(payload) {
    const value = payload.platform_event_id;
    return payload.platform === 'wechat' && typeof value === 'string' && /^message:[1-9][0-9]*$/.test(value) ? value : undefined;
}
export function readImReceivedMessage(connection, payload) {
    const scope = readImConversationScope(connection, payload);
    const eventId = payload.platform_event_id || payload.message_id;
    if (typeof eventId !== 'string' || !eventId)
        throw new Error('IM 入站事件缺少稳定标识');
    return parseImReceivedMessage(connection, {
        version: 1, kind: 'message.received', scope, eventId,
        ...(typeof payload.platform_message_id === 'string' ? { platformMessageId: payload.platform_message_id } : {}),
        ...(typeof payload.platform_user_name === 'string' && payload.platform_user_name.trim()
            ? { platformUserName: payload.platform_user_name.trim().slice(0, 256) } : {}),
        text: typeof payload.text === 'string' ? payload.text : '',
        quotedText: typeof payload.quoted_text === 'string' ? payload.quoted_text : null,
        botMentioned: payload.bot_mentioned === true || payload.group_mentioned === true,
    });
}
