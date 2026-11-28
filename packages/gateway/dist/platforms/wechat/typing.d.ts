import type { createILinkClient } from './client.js';
export declare const WECHAT_TICKET_TTL_MS: number;
export declare const WECHAT_TICKET_RETRY_MS = 2000;
export declare const WECHAT_TICKET_MAX_RETRY_MS: number;
export type WechatTicketResult = {
    readonly status: 'ready';
    readonly ticket: string;
    readonly stale: boolean;
} | {
    readonly status: 'unavailable';
    readonly reason: 'empty_ticket' | 'api_failed' | 'closed';
};
export interface WechatTypingOptions {
    now?(): number;
    random?(): number;
    fetchTimeoutMs?: number;
    keepaliveMs?: number;
    stopTimeoutMs?: number;
    sleep?(ms: number, signal: AbortSignal): Promise<void>;
    report?(code: 'ticket-unavailable' | 'typing-unavailable' | 'typing-revoked' | 'typing-stop-unavailable'): void;
}
/** 每可信Bot/client一个实例；ticket仅在内存，调用者取消不写失败缓存。 */
export declare function createWechatTypingTicketCache(client: Pick<ReturnType<typeof createILinkClient>, 'getConfig'>, options?: WechatTypingOptions): {
    get(user: string, context?: string, signal?: AbortSignal): Promise<WechatTicketResult>;
    close(): Promise<void>;
};
/** 实际ON/OFF协议；每次ON授权复核，停止排空ON后才以独立边界发送OFF。 */
export declare function createWechatTypingIndicator(options: WechatTypingOptions & {
    client: Pick<ReturnType<typeof createILinkClient>, 'sendTyping'>;
    userId: string;
    ticket: string;
    authorize(): Promise<boolean>;
}): {
    isRunning(): boolean;
    start(): Promise<void>;
    stop(): Promise<"stopped" | "unknown">;
};
