import type { QqMediaRequirement } from './message.js';
import type { ProviderTransport } from '@gugu/core/providers';
import { type AddressResolver } from '@gugu/core/providers/node';
export declare class QqMediaIngressError extends Error {
    readonly code: 'qq_media_address' | 'qq_media_download' | 'qq_media_size' | 'qq_media_stage';
    readonly httpStatus?: number | undefined;
    constructor(code: 'qq_media_address' | 'qq_media_download' | 'qq_media_size' | 'qq_media_stage', httpStatus?: number | undefined);
    get notice(): "QQ 附件超出大小限制，请缩小后重新发送。" | "QQ 附件处理失败，请稍后重新发送。" | "暂时无法从 QQ 下载附件，请稍后重新发送。";
}
export declare function downloadQqMedia(raw: unknown, signal: AbortSignal, remaining: number, options: {
    transport: Pick<ProviderTransport, 'request'>;
    resolve?: AddressResolver;
}): Promise<Uint8Array>;
/** 根据实际图片字节确定格式，保留 QQ 语音和表情语义。 */
export declare function describeQqMedia(item: Readonly<Record<string, unknown>>, bytes: Uint8Array): {
    voice: boolean;
    qqFace: boolean;
    ext: string;
    mime: string;
    name: string;
} | null;
/** 直传与表情补图共用下载规则。引用附件由宿主从当前会话存储读取。 */
export declare function materializeQqMedia(item: Readonly<Record<string, unknown>>, budget: {
    readonly remaining: number;
    consume(size: number): boolean;
}, signal: AbortSignal, options: Parameters<typeof downloadQqMedia>[3]): Promise<{
    bytes: Uint8Array<ArrayBufferLike>;
    voice: boolean;
    qqFace: boolean;
    ext: string;
    mime: string;
    name: string;
} | null>;
/** 顺序处理直传与引用；宿主提供会话授权和附件存储。 */
export declare function processQqMedia(items: readonly QqMediaRequirement[], budget: Parameters<typeof materializeQqMedia>[1], signal: AbortSignal, options: Parameters<typeof downloadQqMedia>[3] & {
    authorize?: () => Promise<boolean>;
    quote: (media: QqMediaRequirement, sourceId: string) => Promise<void>;
    file: (media: QqMediaRequirement, file: NonNullable<Awaited<ReturnType<typeof materializeQqMedia>>>, index: number) => Promise<void>;
}): Promise<boolean>;
