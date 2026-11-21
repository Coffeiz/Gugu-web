import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers';
type Method = ProviderHttpRequest['method'];
type Operation = 'auth' | 'gateway' | 'message' | 'stream' | 'media' | 'interaction' | 'close';
export declare class QqApiError extends Error {
    readonly operation: Operation;
    readonly statusCode?: number | undefined;
    readonly errorCode?: number | undefined;
    readonly outcome: 'UNKNOWN' | 'FAILED_CONFIRMED';
    readonly retryable: boolean;
    constructor(operation: Operation, statusCode?: number | undefined, errorCode?: number | undefined, outcome?: 'UNKNOWN' | 'FAILED_CONFIRMED');
}
export interface QqCallOptions {
    body?: Record<string, unknown>;
    signal?: AbortSignal;
    timeoutMs?: number;
    authorize?(): Promise<boolean>;
}
type GatewayResolver = (hostname: string) => Promise<readonly {
    address: string;
    family: 4 | 6;
}[]>;
/** 实例绑定可信Bot配置；固定REST主机，Token不进入URL或公开错误。 */
export declare function createQqClient(options: {
    appId: string;
    appSecret: string;
    sandbox: boolean;
    transport?: ProviderTransport;
    now?: () => number;
    resolveGateway?: GatewayResolver;
}): {
    call: (method: Method, path: string, args?: QqCallOptions) => Promise<Record<string, unknown>>;
    getAccessToken: (signal?: AbortSignal) => Promise<string>;
    getGateway: (signal?: AbortSignal) => Promise<string>;
    close(): Promise<void>;
};
export {};
