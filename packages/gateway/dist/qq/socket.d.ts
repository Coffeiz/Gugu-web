import WebSocket, { type ClientOptions } from 'ws';
import { type AddressResolver } from '@gugu/core/providers/node';
import type { QqSocket } from './connection.js';
/** 每次握手单独校验并固定DNS；代理部署须注入另一个经过验收的连接工厂。 */
export declare function createQqSocketFactory(options: {
    allowDirect: true;
    resolve?: AddressResolver;
    createSocket?(url: string, options: ClientOptions): WebSocket;
}): (value: string, signal: AbortSignal) => Promise<QqSocket>;
