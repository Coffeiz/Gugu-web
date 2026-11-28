import type { ProviderTransport } from '@gugu/core/providers';
import type { createQqClient } from './client.js';
export declare const QQ_ATTACHMENT_MAX_BYTES: number;
type Stage = 'input' | 'prepare' | 'part' | 'finish' | 'complete' | 'close';
export declare class QqMediaUploadError extends Error {
    readonly stage: Stage;
    readonly outcome: 'UNKNOWN' | 'FAILED_CONFIRMED';
    readonly statusCode?: number | undefined;
    readonly errorCode?: number | undefined;
    constructor(stage: Stage, outcome: 'UNKNOWN' | 'FAILED_CONFIRMED', statusCode?: number | undefined, errorCode?: number | undefined);
}
export interface QqMediaUploadInput {
    target: 'users' | 'groups';
    openid: string;
    fileType: 1 | 2 | 3 | 4;
    data: Uint8Array;
    fileName: string;
    signal?: AbortSignal;
    authorize?(): Promise<boolean>;
    partConcurrencyLimit?: 5;
}
/** QQ分块媒体准备，不发送消息；file_info成功也不是消息投递回执。 */
export declare function createQqMediaUploader(options: {
    client: Pick<ReturnType<typeof createQqClient>, 'call'>;
    transport?: ProviderTransport;
    timeoutMs?: number;
    observe?: (metrics: Readonly<Record<string, number>>) => void;
}): {
    upload(input: QqMediaUploadInput): Promise<Record<string, unknown>>;
    close(): Promise<void>;
};
export {};
