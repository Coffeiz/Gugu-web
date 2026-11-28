import type { GatewayClock, GatewayConnection } from '../../index.js';
export type QqMessageEvent = 'C2C_MESSAGE_CREATE' | 'GROUP_AT_MESSAGE_CREATE' | 'GROUP_MESSAGE_CREATE' | 'INTERACTION_CREATE';
export interface QqSocket {
    /** 工厂必须在 close/取消后终止迭代，不得在此端口输出原始报文日志。 */
    packets: AsyncIterable<unknown>;
    send(packet: Readonly<Record<string, unknown>>): Promise<void>;
    close(): Promise<void>;
}
export interface QqConnectionPorts {
    getAccessToken(signal: AbortSignal): Promise<string>;
    getGateway(token: string, signal: AbortSignal): Promise<string>;
    /** 可信 Host 工厂负责 URL/DNS/TLS、安全目标与取消；该端口本身不代表生产安全网络已接通。 */
    openSocket(url: string, signal: AbortSignal): Promise<QqSocket>;
    onEvent(type: QqMessageEvent, data: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
    onReadyChange?(ready: boolean): void;
    clock?: GatewayClock;
    report?(event: 'connection-failed' | 'event-failed' | 'heartbeat-failed' | 'heartbeat-timeout' | 'cleanup-failed', error?: unknown): void;
}
/** QQ raw WebSocket 协议运行时。Token 仅用于内存握手，不进入 URL、公开错误或日志。 */
export declare function createQqConnection(ports: QqConnectionPorts): GatewayConnection;
