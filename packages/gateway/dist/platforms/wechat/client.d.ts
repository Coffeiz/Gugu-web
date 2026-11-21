import type { ProviderTransport } from '@gugu/core/providers';
export declare const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const ILINK_CHANNEL_VERSION = "2.0.1";
type Body = Record<string, unknown>;
/** 不持有原异常、上下文凭证、请求URL或平台原始响应。 */
export declare class ILinkApiError extends Error {
    readonly operation: string;
    readonly outcome: 'rejected' | 'unknown';
    readonly statusCode?: number | undefined;
    readonly ret?: number | undefined;
    constructor(operation: string, outcome: 'rejected' | 'unknown', statusCode?: number | undefined, ret?: number | undefined);
}
/** 扫码返回的可信配置仍不得把Bearer凭据送往任意主机或路径。 */
export declare function validateILinkBaseUrl(value: string): string;
export interface ILinkClientOptions {
    botToken: string;
    baseUrl?: string;
    transport?: ProviderTransport;
    randomUin?(): number;
    generateId?(): string;
}
/** 仅封装当前iLink HTTP协议；连接监督、游标和业务授权由Host调用方负责。 */
export declare function createILinkClient(options: ILinkClientOptions): {
    getUpdates(cursor?: string, signal?: AbortSignal): Promise<Body>;
    sendMessage: (message: Body, signal?: AbortSignal, authorize?: () => Promise<boolean>) => Promise<Body>;
    sendText(toUserId: string, text: string, contextToken: string, signal?: AbortSignal): Promise<Body>;
    getUploadUrl(body?: Body, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<Body>;
    getConfig(userId: string, contextToken?: string, signal?: AbortSignal): Promise<Body>;
    sendTyping(userId: string, ticket: string, status: 1 | 2, signal?: AbortSignal): Promise<Body>;
    notifyStart(signal?: AbortSignal): Promise<Body>;
    notifyStop(signal?: AbortSignal): Promise<Body>;
    close(): Promise<void>;
};
export {};
