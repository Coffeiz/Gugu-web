import type { Agent } from 'node:https';
import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import type { ProviderTransport } from '@gugu/core/providers';
import type { GatewayConnection } from '../../index.js';
type SdkOptions = ConstructorParameters<typeof WSClient>[0];
export interface FeishuSdkClient {
    start(options: {
        eventDispatcher: EventDispatcher;
    }): Promise<void>;
    close(options: {
        force: boolean;
    }): void;
}
export interface FeishuWsNetwork {
    /** 可信 Host 专用 HTTPS Agent：必须固定已校验DNS地址并保持原域名TLS/SNI校验。 */
    agent: Agent;
    /** 每次 discovery 与重连均调用；此校验必须与上述 Agent 的实际连接目标一致。 */
    validateEndpoint(url: string, signal: AbortSignal): Promise<void>;
    close(): Promise<void>;
}
export interface FeishuConnectionOptions {
    appId: string;
    appSecret: string;
    wsNetwork: FeishuWsNetwork;
    transport?: ProviderTransport;
    createSdkClient?(options: SdkOptions): FeishuSdkClient;
    onMessage(data: unknown, signal: AbortSignal): Promise<void>;
    onCardAction(data: unknown, signal: AbortSignal): Promise<unknown>;
    signal?: AbortSignal;
    readyTimeoutMs?: number;
    report?(event: 'sdk-error' | 'sdk-warning' | 'event-failed' | 'misrouted-event' | 'reconnecting' | 'reconnected' | 'connection-failed' | 'cleanup-failed', error?: unknown): void;
}
/** 使用真实SDK协议；没有可信安全WS Agent时不提供生产默认连接。 */
export declare function createFeishuConnection(options: FeishuConnectionOptions): Promise<GatewayConnection>;
export {};
