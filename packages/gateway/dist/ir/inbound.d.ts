export interface ImConnectionIdentity {
    readonly ownerId: string;
    readonly botId: string;
    readonly platform: 'feishu' | 'qq' | 'wechat' | 'telegram';
}
export type ImConversationScope = ImConnectionIdentity & {
    readonly chatType: 'c2c' | 'group';
    readonly chatId: string | null;
    readonly platformUserId: string;
};
export interface ImReceivedMessage {
    readonly version: 1;
    readonly kind: 'message.received';
    readonly scope: ImConversationScope;
    readonly eventId: string;
    readonly platformMessageId?: string;
    readonly platformUserName?: string;
    readonly text: string;
    readonly quotedText: string | null;
    readonly botMentioned: boolean;
}
/** 重新读取序列化事件时，核对完整结构和可信连接归属。 */
export declare function parseImReceivedMessage(connection: ImConnectionIdentity, value: unknown): ImReceivedMessage;
/** 连接身份由宿主提供，平台载荷仅用于核对来源和提取会话事实。 */
export declare function readImConversationScope(connection: ImConnectionIdentity, payload: Record<string, unknown>): ImConversationScope;
/** 微信会话令牌只用于回复，去重优先使用平台消息身份。 */
export declare function wechatEventId(payload: Readonly<Record<string, unknown>>): string | undefined;
export declare function readImReceivedMessage(connection: ImConnectionIdentity, payload: Record<string, unknown>): ImReceivedMessage;
