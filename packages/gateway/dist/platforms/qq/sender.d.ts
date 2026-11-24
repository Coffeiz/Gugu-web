import { type QqLinkButton } from '@gugu/core/im/qq-text';
import { type createQqClient } from './client.js';
import { z } from 'zod';
/** 只提前发送不会被后续链接、围栏或 Markdown 标记重写的纯文本部分。 */
export declare function qqStreamPrefix(text: string): string;
type Outcome = 'accepted' | 'rejected' | 'unknown';
export interface QqReceipt {
    outcome: Outcome;
    platformMessageIds: readonly string[];
}
export interface QqTarget {
    id: string;
    chatType: 'c2c' | 'group';
    messageId?: string;
    messageFormat?: 'compat' | 'markdown';
    mentionUserId?: string;
    mentionUserName?: string;
    /** 仅接受Host从当前群授权资料读取的名单。 */
    knownMemberIds?: readonly string[];
}
export interface QqSequencePort {
    /** Host必须Redis原子INCR+仅首次EXPIRE；普通消息、媒体和流首帧共用同一键。 */
    nextPassive(input: {
        botId: string;
        messageId: string;
        ttlSeconds: 4200;
    }): Promise<number>;
    /** 没有被动msg_id的独立流使用共享持久计数，禁止本地时间戳兜底。 */
    nextStream(input: {
        botId: string;
        ttlSeconds: 600;
    }): Promise<number>;
}
export interface QqStreamReceipt extends QqReceipt {
    closed: boolean;
    reason?: 'prefix-mismatch';
    definitelyUnsent?: true;
}
declare const streamSnapshotSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    binding: z.ZodString;
    fullText: z.ZodString;
    lastSentText: z.ZodString;
    lastSentContent: z.ZodString;
    streamId: z.ZodNullable<z.ZodString>;
    msgSeq: z.ZodNullable<z.ZodNumber>;
    index: z.ZodNumber;
    finished: z.ZodBoolean;
    closed: z.ZodBoolean;
    failed: z.ZodBoolean;
    rejectedContent: z.ZodBoolean;
    flushInterval: z.ZodNumber;
}, z.core.$strict>;
export type QqStreamSnapshot = z.infer<typeof streamSnapshotSchema>;
export declare function parseQqStreamSnapshot(input: unknown): QqStreamSnapshot;
/** 必须来自统一交互服务的可信投影，不能从模型工具参数创建或补充token。 */
export interface QqInteractionPrompt {
    prompt_id: number;
    title?: string;
    body?: string;
    task_paused?: boolean;
    allow_text_input?: boolean;
    native_keyboard?: boolean;
    secret_fields?: readonly unknown[];
    group_secret_blocked?: boolean;
    resolved?: boolean;
    options?: readonly {
        id?: string;
        label?: string;
        token?: string;
    }[];
}
export interface QqButtonReceipt extends QqReceipt {
    delivery: 'native' | 'text' | 'none';
    buttonCount: number;
}
export declare function buildQqKeyboard(prompt: QqInteractionPrompt): Record<string, unknown>;
/** 只呈现已授权选项，绝不把token、secret字段值或session写进用户说明。 */
export declare function formatQqInteractionFallback(prompt: QqInteractionPrompt): string;
/** 只有来自当前群的可信成员 ID 能被转成 QQ 提及。 */
export declare function splitQqGroupMentions(text: string, userId?: string, known?: readonly string[], userName?: string): {
    mention: string;
    body: string;
};
export declare function createQqSender(options: {
    botId: string;
    client: Pick<ReturnType<typeof createQqClient>, 'call'>;
    sequences: QqSequencePort;
    /** 复用Host已装配的实际出站清洗，不允许中间帧与最终帧使用不同规则。 */
    sanitizeText(text: string): string;
    normalizePrefix?(text: string): string;
    sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}): {
    prepareText(text: string): string;
    text(target: QqTarget, text: string, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<QqReceipt>;
    keyboard(target: QqTarget, text: string, prompt: QqInteractionPrompt, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<QqReceipt>;
    interaction(target: QqTarget, prompt: QqInteractionPrompt, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<QqButtonReceipt>;
    linkButtons(target: QqTarget, message: string, buttons: readonly QqLinkButton[], signal?: AbortSignal): Promise<QqButtonReceipt>;
    /** 只确认收到平台回调；授权/一次性action消费与Run恢复必须由Host另行执行。 */
    ackInteraction(eventId: string, code?: 0 | 3, signal?: AbortSignal): Promise<{
        outcome: Outcome;
        acknowledged: boolean;
    }>;
    /** fileInfo只能来自实际QQ媒体上传结果；此入口不生成或猜测平台文件凭证。 */
    media(target: QqTarget, uploaded: {
        fileInfo: string;
        image: boolean;
        filename?: string;
    }, signal?: AbortSignal, authorize?: () => Promise<boolean>, onFailure?: (status?: number, code?: number) => void): Promise<QqReceipt>;
    privateStream(target: QqTarget, signal?: AbortSignal, lifecycle?: {
        authorize?: () => Promise<boolean>;
        automaticFlush?: boolean;
        partialText?: boolean;
        snapshot?: unknown;
        checkpoint?(snapshot: QqStreamSnapshot): Promise<void>;
    }): {
        push(delta: string): void;
        flush: () => Promise<QqStreamReceipt>;
        finish(finalText?: string, args?: {
            allowRewrite?: boolean;
        }): Promise<QqStreamReceipt>;
        state(): {
            fullText: string;
            lastSentText: string;
            lastSentContent: string;
            streamId: string | null;
            index: number;
            finished: boolean;
        };
        snapshot: () => QqStreamSnapshot;
    };
};
export {};
