import { type createFeishuClient } from './client.js';
import { type ParsedFeishuMessage } from './message.js';
export declare class FeishuMediaIngressError extends Error {
    readonly code: 'feishu_media_download' | 'feishu_media_stage';
    readonly httpStatus?: number | undefined;
    constructor(code: 'feishu_media_download' | 'feishu_media_stage', httpStatus?: number | undefined);
    get notice(): "暂时无法从飞书下载附件，请稍后重新发送。" | "飞书附件保存失败，请稍后重新发送。";
}
type FeishuMediaFile = {
    name: string;
    ext: string;
    mime: string;
    bytes: Uint8Array;
    voice: boolean;
};
/** 在同一批次额度内下载飞书附件，并按消息顺序交给宿主暂存。 */
export declare function processFeishuMedia(items: ParsedFeishuMessage['mediaItems'], client: Pick<ReturnType<typeof createFeishuClient>, 'downloadResource'>, options: {
    maxBytes: number;
    maxFiles?: number;
    signal: AbortSignal;
    authorize?: () => Promise<boolean>;
}, stage: (file: FeishuMediaFile, index: number) => Promise<void>): Promise<void>;
/** 仅返回飞书查询确认属于当前会话的引用事实。 */
export declare function readFeishuQuote(parsed: ParsedFeishuMessage, client: Pick<ReturnType<typeof createFeishuClient>, 'call'>, botOpenId: string | null, signal: AbortSignal, authorize?: () => Promise<boolean>): Promise<{
    quoted_text: string | null;
    reply_target_sender_id: string | null;
    reply_target_is_bot: boolean | null;
} | null>;
export {};
