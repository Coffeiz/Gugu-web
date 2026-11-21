type ObjectValue = Record<string, unknown>;
type MentionFact = boolean | null;
export interface QqEmojiRef {
    face_type: string;
    face_id: string;
}
export declare function extractQqFaces(value: string): QqEmojiRef[];
export declare function normalizeQqFaces(value: string): string;
export declare function normalizeQqAttachmentPlaceholders(value: string, attachments: readonly unknown[]): string;
export declare function qqPlatformSentMs(data: ObjectValue): number | null;
export interface QqMediaRequirement {
    source: 'message' | 'quote';
    attachmentIndex: number;
    sourcePlatformMessageId: string | null;
    item: ObjectValue;
}
export interface QqInboundPayload extends ObjectValue {
    platform: 'qq';
    channel_id: string;
    bot_id: string;
    owner_user_id: string;
    platform_user_id: string;
    platform_user_name: string | null;
    platform_bot_user_id: string | null;
    message_id: string;
    platform_message_id: string;
    platform_sent_ms: number | null;
    chat_type: 'group' | 'c2c';
    chat_id?: string;
    text: string;
    attention_raw_text: string;
    quoted_text: string | null;
    attachments: string[];
    emoji_refs: QqEmojiRef[];
    qq_face_marker: boolean;
    bot_mentioned: boolean;
    group_mentioned: boolean;
    native_bot_mentioned: MentionFact;
    mentions_other_bot: MentionFact;
    mentions_other_member: MentionFact;
    has_unresolved_mention: boolean;
    reply_to_platform_message_id: string | null;
    reply_target_sender_id: string | null;
    reply_target_is_bot: MentionFact;
}
export interface ParsedQqMessage {
    payload: QqInboundPayload;
    rawText: string;
    preflight: ObjectValue;
    mediaItems: QqMediaRequirement[];
    /** Host用完整scope查询引用索引，不能按裸ref ID跨群或跨Bot查找。 */
    quoteRequest: {
        referenceIndex: string;
        chatType: 'group' | 'c2c';
        chatId: string;
        senderId: string;
        contentRequired: boolean;
    } | null;
    /** 含正文/签名URL，只能在前置安全检查后交给受控索引，不能日志或明文跨端同步。 */
    indexEntry: ObjectValue;
    splitFace: {
        waitForImage: boolean;
        faceOnly: boolean;
        emojiRefs: QqEmojiRef[];
    };
}
/** WS回调已验证事件来源后调用；群策略、绑定码、引用存储、媒体与分离表情关联留Host。 */
export declare function parseQqMessage(eventType: string, raw: unknown, options: {
    botId: string;
    ownerId: string;
}): ParsedQqMessage | null;
export {};
