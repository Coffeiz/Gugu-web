import { type TelegramInboundPayload } from '@gugu/core/im/telegram-message';
import { type GatewayConnection } from '../contracts.js';
import type { GatewayInbox } from '../ports.js';
type ObjectValue = Record<string, unknown>;
export interface TelegramPollingApi {
    call(token: string, method: string, options?: {
        payload?: ObjectValue;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<unknown>;
    close(): void | Promise<void>;
}
export interface TelegramPollingOptions {
    botId: string;
    ownerId: string;
    expectedPlatformBotId?: string;
    token: string;
    api: TelegramPollingApi;
    inbox: GatewayInbox;
    signal: AbortSignal;
    /** 必须先执行凭据输入拦截和实时取消；已消费消息不得进入普通队列。 */
    preflight(payload: TelegramInboundPayload, signal: AbortSignal): Promise<'enqueue' | 'consumed'>;
    /** 生产装配必须提供。待下载/引用媒体不能未经暂存直接进入普通队列。 */
    materialize?(payload: TelegramInboundPayload, signal: AbortSignal): Promise<ObjectValue | null>;
    /** 必须通过统一交互服务进行归属检查和一次性消费；临时故障返回 false。 */
    callback(query: ObjectValue, signal: AbortSignal): Promise<boolean>;
    sleep?(ms: number, signal: AbortSignal): Promise<void>;
    onPollStatus?(status: 'ready' | 'conflict' | 'retrying'): void;
    report?(event: 'poll-unavailable', error?: unknown): void;
}
/** 每 Bot 长轮询；不替代 IM 入站事务、权限与 Agent 运行处理。 */
export declare function connectTelegramPolling(options: TelegramPollingOptions): Promise<GatewayConnection>;
export {};
