/** Telegram 原生事件解析；身份和权限必须由可信 Host 与 IM 用例另行校验。 */
type ObjectValue = Record<string, unknown>;
type MentionFact = boolean | null;
export interface TelegramMessageOptions {
    botId: string;
    ownerId: string;
    botUsername: string;
    botPlatformId?: string;
}
export interface TelegramMedia extends ObjectValue {
    file_id: unknown;
    file_size: unknown;
    file_name: string;
    mime_type: string;
    media_type: string;
}
export interface TelegramInboundPayload extends ObjectValue {
    platform: 'telegram';
    channel_id: string;
    bot_id: string;
    owner_user_id: string;
    chat_type: 'c2c' | 'group';
    chat_id: string;
    platform_user_id: string;
    platform_user_name: string | null;
    message_id: string;
    platform_message_id: string;
    platform_event_id: string;
    text: string;
    attention_raw_text: string;
    attachments: TelegramMedia[];
    quoted_attachments: TelegramMedia[];
    attachment_source_message_id: string | null;
    bot_mentioned: boolean;
    native_bot_mentioned: MentionFact;
    mentions_other_member: MentionFact;
    mentions_other_bot: MentionFact;
    has_unresolved_mention: boolean;
    group_mentioned: boolean;
    reply_to_message_id: string | null;
    reply_to_platform_message_id: string | null;
    reply_target_sender_id: string | null;
    reply_target_is_bot: MentionFact;
    platform_sent_ms: number | null;
    sender_is_bot: false;
    quoted_text: string | null;
    telegram_command: string | null;
    received_at: unknown;
}
export declare function telegramEntityText(text: string, entity: ObjectValue): string;
export declare function normalizeTelegramCommand(text: string, entities: readonly unknown[], botUsername: string): readonly [string, string] | null;
/** 保留 Python parser 的 edited_message 兼容；轮询入口必须另行拒绝编辑事件。 */
export declare function normalizeTelegramMessage(update: ObjectValue, options: TelegramMessageOptions): TelegramInboundPayload | null;
export {};
