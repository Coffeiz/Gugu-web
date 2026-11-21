type ObjectValue = Record<string, unknown>;
export interface WechatQuote {
    quotedText: string | null;
    /** 原始图片描述含AES材料及CDN参数，只供Host内存使用，不得记录或发给模型。 */
    mediaItems: ObjectValue[];
}
/** iLink通常不给引用原文；保留旧占位，不凭msg_id猜测原文或扩展文件/视频下载。 */
export declare function extractWechatQuote(refMessage: unknown): WechatQuote;
/** 保留Python int转换语义；超出JS精确整数范围的值拒绝用作消息顺序。 */
export declare function wechatPlatformSentMs(message: ObjectValue): number | null;
export interface WechatInboundPayload extends ObjectValue {
    platform: 'wechat';
    channel_id: string;
    bot_id: string;
    owner_user_id: string;
    platform_user_id: string;
    /** 与Python兼容；这是会话秘密，Host持久化前必须加密，禁止作为可见日志/模型输入。 */
    message_id: string;
    platform_event_id?: string;
    context_token: string;
    platform_sent_ms: number | null;
    chat_type: 'group' | 'c2c';
    chat_id?: string;
    wechat_group_id: string;
    text: string;
    quoted_text: string | null;
    /** 解析阶段始终为空；只有Host实际下载/解密/授权暂存后才能填真实ID。 */
    attachments: string[];
}
export interface WechatMediaRequirement {
    source: 'message' | 'quote';
    kind: 'image' | 'unsupported';
    /** 含平台媒体秘密，只留内存；不允许直接入模型、日志或明文队列。 */
    item: ObjectValue;
}
export interface ParsedWechatMessage {
    payload: WechatInboundPayload;
    mediaItems: WechatMediaRequirement[];
    hasQuote: boolean;
    voiceTranscriptionMissing?: true;
}
/**
 * 只解析用户→Bot消息。凭据预检、媒体、typing和入队由Host按该顺序执行。
 * Host在预检通过后处理mediaItems，只有unsupported媒体且无正文时不得启动Agent。
 */
export declare function parseWechatMessage(message: unknown, options: {
    botId: string;
    ownerId: string;
}): ParsedWechatMessage | null;
export declare const WECHAT_MISSING_VOICE_NOTICE = "\u6CA1\u6536\u5230\u8FD9\u6761\u8BED\u97F3\u7684\u8F6C\u5199\uFF0C\u8BF7\u91CD\u53D1\u8BED\u97F3\u6216\u6539\u7528\u6587\u5B57\u3002";
export {};
