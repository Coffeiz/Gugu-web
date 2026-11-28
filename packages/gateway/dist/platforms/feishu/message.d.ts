type ObjectValue = Record<string, unknown>;
type MentionFact = boolean | null;
/** 与Python一致递归兼容旧卡片和CardKit2.0，仅抽取markdown/text可读节点。 */
export declare function extractFeishuCardText(value: unknown): string;
export interface FeishuQuoteFacts {
    text: string | null;
    sender_id: string | null;
    sender_is_bot: MentionFact;
    platform_sent_ms: number | null;
}
/** 仅处理Host实际查询到的message item；不会按parent_id猜测内容或读取网络。 */
export declare function parseFeishuQuoteFacts(message: unknown, botOpenId: string | null): FeishuQuoteFacts;
export interface FeishuMessageOptions {
    botId: string;
    ownerId: string;
    appId: string;
    botOpenId: string | null;
    nowMs: number;
}
export interface FeishuMediaRequirement {
    messageId: string;
    resourceKey: string;
    resourceType: 'image' | 'file';
    fileName: string;
    isVoice: boolean;
    source: 'message' | 'post';
}
export interface FeishuInboundPayload extends ObjectValue {
    platform: 'feishu';
    channel_id: string;
    bot_id: string;
    owner_user_id: string;
    platform_user_id: string;
    chat_id: string;
    chat_type: 'group' | 'c2c';
    message_id: string;
    platform_message_id: string;
    platform_sent_ms: number | null;
    text: string;
    attention_raw_text: string;
    quoted_text: null;
    reply_to_platform_message_id: string | null;
    reply_target_sender_id: null;
    reply_target_is_bot: null;
    sender_is_bot: MentionFact;
    native_bot_mentioned: MentionFact;
    mentions_other_bot: MentionFact;
    mentions_other_member: MentionFact;
    has_unresolved_mention: boolean;
    bot_mentioned: boolean;
    group_mentioned: boolean;
    processable_media: false;
    attachments: string[];
}
export interface ParsedFeishuMessage {
    kind: 'message';
    payload: FeishuInboundPayload;
    mediaItems: FeishuMediaRequirement[];
    /** Host先消费凭据输入，再下载媒体和远程引用；不能把预检输入提前持久化。 */
    preflight: ObjectValue;
    quoteRequest: {
        messageId: string;
        cardContentType: 'user_card_content';
    } | null;
}
export interface ParsedFeishuCardAction {
    kind: 'card_action';
    ownerId: string;
    botId: string;
    eventId: string | null;
    operatorId: string;
    promptId: number;
    /** 一次性授权秘密，仅交给Host交互服务，禁止日志/模型正文。 */
    actionToken: string;
    optionId: string;
    label: string;
}
/** Host验证WebSocket/签名来源后调用；不创建网络、读取配置、下载资源或伪造引用。 */
export declare function parseFeishuEvent(raw: unknown, options: FeishuMessageOptions): ParsedFeishuMessage | ParsedFeishuCardAction | null;
export {};
