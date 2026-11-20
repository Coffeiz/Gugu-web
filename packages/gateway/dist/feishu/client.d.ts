import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers';
type Method = ProviderHttpRequest['method'];
type Operation = 'auth' | 'message' | 'reaction' | 'media' | 'card' | 'identity' | 'close';
export declare class FeishuApiError extends Error {
    readonly operation: Operation;
    readonly statusCode?: number | undefined;
    readonly errorCode?: number | undefined;
    constructor(operation: Operation, statusCode?: number | undefined, errorCode?: number | undefined);
}
export interface FeishuUpload {
    name: string;
    data: Uint8Array;
    contentType: string;
}
export interface FeishuCallOptions {
    body?: Record<string, unknown>;
    files?: Record<string, FeishuUpload>;
    signal?: AbortSignal;
    timeoutMs?: number;
    authorize?(): Promise<boolean>;
}
/** 飞书固定官方API；实例绑定一份可信Bot凭据，不从请求正文取得身份或网络目标。 */
export declare function createFeishuClient(options: {
    appId: string;
    appSecret: string;
    transport?: ProviderTransport;
    now?: () => number;
}): {
    call: (method: Method, path: string, args?: FeishuCallOptions) => Promise<Record<string, unknown>>;
    downloadResource: (messageId: string, fileKey: string, type: "image" | "file", args: {
        maxBytes: number;
        signal?: AbortSignal;
    }) => Promise<Uint8Array>;
    close(): Promise<void>;
};
export {};
