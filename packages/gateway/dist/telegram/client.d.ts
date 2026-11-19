import type { ProviderTransport } from '@gugu/core/providers';
export declare const TELEGRAM_DOWNLOAD_MAX_BYTES: number;
/** 错误只持有协议状态，不保留 URL、Token、原始异常或上游正文。 */
export declare class TelegramApiError extends Error {
    readonly operation: string;
    readonly statusCode?: number | undefined;
    readonly errorCode?: number | undefined;
    readonly retryAfter?: number | undefined;
    constructor(operation: string, statusCode?: number | undefined, errorCode?: number | undefined, retryAfter?: number | undefined);
}
export declare function validateTelegramBotToken(token: string): string;
export interface TelegramUpload {
    name: string;
    data: Uint8Array;
    contentType: string;
}
export interface TelegramCallOptions {
    payload?: Record<string, unknown>;
    files?: Record<string, TelegramUpload>;
    timeoutMs?: number;
    signal?: AbortSignal;
    authorize?(): Promise<boolean>;
}
/** 官方协议要求 Token 置于内部请求路径；该例外不允许任意目标、重定向或记录请求 URL。 */
export declare function createTelegramBotApi(options?: {
    transport?: ProviderTransport;
}): {
    call: (token: string, method: string, args?: TelegramCallOptions) => Promise<unknown>;
    downloadFile: (token: string, filePath: string, args?: {
        maxBytes?: number;
        signal?: AbortSignal;
    }) => Promise<Uint8Array>;
    close(): Promise<void>;
};
