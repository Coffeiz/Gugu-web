import { type createTelegramBotApi } from './client.js';
/** 入站额度使用十进制 MB。 */
export declare const TELEGRAM_INGRESS_MAX_BYTES = 20000000;
export declare class TelegramMediaIngressError extends Error {
    readonly code: 'cancelled' | 'storage_contract' | 'reuse_failed' | 'cleanup_failed' | 'close_failed';
    constructor(code: 'cancelled' | 'storage_contract' | 'reuse_failed' | 'cleanup_failed' | 'close_failed');
}
export type TelegramInboundFile = {
    name: string;
    ext: string;
    mime: string;
    data: Uint8Array;
    kind: 'image' | 'voice' | 'file';
    duration: number | null;
    attachmentIndex: number;
};
/** 下载实际文件并交给已授权的宿主暂存，允许同批其他附件继续处理。 */
export declare function processTelegramAttachments(api: Pick<ReturnType<typeof createTelegramBotApi>, 'call' | 'downloadFile'>, token: string, attachments: readonly unknown[], signal: AbortSignal, stage: (file: TelegramInboundFile, signal: AbortSignal) => Promise<void>, authorize?: () => Promise<boolean>): Promise<{
    sizeLimitExceeded: boolean;
    failureNotice: string | null;
}>;
/** 引用只携带可信会话内的来源键与附件索引。 */
export declare function telegramAttachmentReference(item: Record<string, unknown>): {
    sourceMessageId: string;
    sourceIndex: number;
} | null;
