import type { ImConversationScope } from '../ir/inbound.js';
import type { createFeishuSender } from '../platforms/feishu/sender.js';
import { QqMediaUploadError, type createQqMediaUploader } from '../platforms/qq/media-upload.js';
import type { createQqSender } from '../platforms/qq/sender.js';
import type { createTelegramSender } from '../platforms/telegram/sender.js';
import type { createWechatSender } from '../platforms/wechat/sender.js';
type MediaSender = {
    platform: 'feishu';
    sender: Pick<ReturnType<typeof createFeishuSender>, 'file'>;
} | {
    platform: 'qq';
    sender: Pick<ReturnType<typeof createQqSender>, 'media'>;
    mediaUpload: Pick<ReturnType<typeof createQqMediaUploader>, 'upload'>;
} | {
    platform: 'telegram';
    sender: Pick<ReturnType<typeof createTelegramSender>, 'file'>;
} | {
    platform: 'wechat';
    sender: Pick<ReturnType<typeof createWechatSender>, 'image' | 'file'>;
};
export declare const imOutboundMediaLimits: Readonly<{
    qq: number;
    wechat: number;
    telegram: number;
    feishu: number;
}>;
export declare function validateImOutboundFile(platform: ImConversationScope['platform'], file: {
    name: unknown;
    ext: unknown;
    mime: unknown;
    size: number;
}): file is {
    name: string;
    ext: string;
    mime: string;
    size: number;
};
type ImMediaInput = {
    platform: MediaSender;
    scope: Pick<ImConversationScope, 'platform' | 'chatId' | 'chatType' | 'platformUserId'>;
    file: {
        name: string;
        ext: string;
        mime: string;
    };
    bytes: Uint8Array;
    feishuChatId?: unknown;
    wechatContextToken?: unknown;
    authorize(): Promise<boolean>;
    signal?: AbortSignal;
    onQqMessageFailure?: (httpStatus?: number, upstreamCode?: number) => void;
    onQqUploadFailure?: (error: QqMediaUploadError) => void;
};
/** 宿主验证文件和会话归属后，按平台协议上传并投递。 */
export declare function sendImMedia(input: ImMediaInput): Promise<{
    recipient: string;
    receipt: import("../platforms/wechat/sender.js").WechatSendReceipt;
} | null>;
type QqMediaInput = ImMediaInput & {
    platform: Extract<MediaSender, {
        platform: 'qq';
    }>;
};
/** 上传最多预取一张，发送顺序及单件回执仍由原发送器决定。 */
export declare function sendQqImageBatch(inputs: readonly QqMediaInput[]): AsyncGenerator<{
    index: number;
    outcome: "accepted" | "rejected" | "unknown";
}, void, unknown>;
export {};
