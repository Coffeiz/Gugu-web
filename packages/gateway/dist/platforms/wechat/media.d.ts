import type { WechatMediaRequirement } from './message.js';
import type { ProviderTransport } from '@gugu/core/providers';
import type { createILinkClient } from './client.js';
export declare const WECHAT_MEDIA_MAX_BYTES: number;
type ObjectValue = Record<string, unknown>;
/** 只保留固定操作/结果类别；不持有URL、AES材料、正文、文件名或CDN响应。 */
export declare class WechatMediaError extends Error {
    readonly operation: 'configure' | 'download' | 'upload';
    readonly outcome: 'rejected' | 'unknown';
    readonly statusCode?: number | undefined;
    constructor(operation: 'configure' | 'download' | 'upload', outcome: 'rejected' | 'unknown', statusCode?: number | undefined);
}
/** 仅当前已知官方CDN路径；不能借平台返回URL扩大Host出网白名单。 */
export declare function validateWechatCdnUrl(raw: string, operation: 'download' | 'upload'): string;
export declare function createWechatMedia(options: {
    client: Pick<ReturnType<typeof createILinkClient>, 'getUploadUrl'>;
    transport?: ProviderTransport;
    /** 只能收紧默认资源上限；Host另行限制每批媒体数量和用户配额。 */
    maxBytes?: number;
}): {
    downloadImage: (item: unknown, signal?: AbortSignal, authorize?: () => Promise<boolean>) => Promise<{
        bytes: Buffer;
        ext: "jpg" | "png" | "gif" | "webp";
        mime: string;
    } | null>;
    prepareItem: (input: {
        kind: "image" | "file";
        data: Uint8Array;
        toUserId: string;
        fileName?: string;
        authorize?(): Promise<boolean>;
    }, signal?: AbortSignal) => Promise<ObjectValue>;
    close(): Promise<void>;
};
/** 共享微信图片筛选、配额和顺序，宿主提供已授权的暂存端口。 */
export declare function processWechatImages(items: readonly WechatMediaRequirement[], media: Pick<ReturnType<typeof createWechatMedia>, 'downloadImage'>, options: {
    maxBytes: number;
    maxFiles?: number;
    signal: AbortSignal;
    authorize?: () => Promise<boolean>;
}, stage: (file: {
    bytes: Uint8Array;
    name: string;
    ext: string;
    mime: string;
    voice: false;
}, index: number, quoted: boolean) => Promise<void>): Promise<void>;
export {};
