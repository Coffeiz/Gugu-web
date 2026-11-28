import type { ProviderTransport } from '@gugu/core/providers';
import type { GatewayPairingStore } from '../../ports.js';
export declare class FeishuConnectionError extends Error {
    readonly statusCode: number;
    name: string;
    constructor(statusCode: number, message: string);
}
export interface FeishuPairingProtocolOptions {
    transport: ProviderTransport;
    store: GatewayPairingStore;
    portalBase: string;
    allowLocal?: boolean;
    stateAvailable?: boolean;
    generateId(): string;
    platforms(): readonly string[] | Promise<readonly string[]>;
}
export type FeishuPairingOptions = FeishuPairingProtocolOptions & {
    saveBot(owner: string, app: string, secret: string, oid: string | null): Promise<{
        id: number;
        name: string;
        app_id: string;
    }>;
};
export declare function createFeishuPairing(options: FeishuPairingOptions): {
    start(ownerId: string): Promise<{
        poll_id: string;
        scan_url: string;
    }>;
    poll(ownerId: string, id: string): Promise<{
        status: string;
        reason?: string;
        bot?: {
            id: number;
            name: string;
            app_id: string;
        };
    }>;
};
