import type { GatewayPairingStore } from '../../ports.js';
import type { ProviderTransport } from '@gugu/core/providers';
export declare class WechatConnectionError extends Error {
    readonly statusCode: number;
    name: string;
    constructor(statusCode: number, message: string);
}
export interface WechatPairingOptions {
    transport: ProviderTransport;
    store: GatewayPairingStore;
    portalBase: string;
    allowLocal?: boolean;
    stateAvailable?: boolean;
    generateId(): string;
    randomUin(): number;
    platforms(): readonly string[] | Promise<readonly string[]>;
}
interface WechatPairingPersistence {
    saveBot(owner: string, token: string, base: string, identity: {
        botId: unknown;
        userId: unknown;
    }): Promise<{
        id: number;
        name: string;
    }>;
    onSaved?(owner: string): Promise<void>;
}
/** 微信扫码和轮询共用协议，凭据交给当前运行时持久化。 */
export declare function createWechatPairing(options: WechatPairingOptions & WechatPairingPersistence): {
    start(ownerId: string): Promise<{
        task_id: string;
        scan_url: string;
    }>;
    poll(ownerId: string, id: string): Promise<{
        status: string;
        reason?: string;
        bot?: {
            id: number;
            name: string;
        };
    }>;
};
export {};
