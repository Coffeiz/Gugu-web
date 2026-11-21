import type { ProviderTransport } from '@gugu/core/providers';
import type { GatewayPairingStore } from '../../ports.js';
export declare class QqConnectionError extends Error {
    readonly statusCode: number;
    name: string;
    constructor(statusCode: number, message: string);
}
export interface QqPairingProtocolOptions {
    transport: ProviderTransport;
    store: GatewayPairingStore;
    portalBase: string;
    allowLocal?: boolean;
    stateAvailable?: boolean;
    generateKey(): string;
    platforms(): readonly string[] | Promise<readonly string[]>;
}
/** 扫码挑战只存宿主；HTTP协议使用同一安全传输，成功提交后才清挑战并通知。 */
export type QqPairingOptions = QqPairingProtocolOptions & {
    saveBot(owner: string, app: string, secret: string, userOpenId?: string): Promise<{
        id: number;
        name: string;
        app_id: string;
    } | null>;
    onSaved?(owner: string): Promise<void>;
};
export declare function createQqPairing(options: QqPairingOptions): {
    start(ownerId: string): Promise<{
        task_id: string;
        scan_url: string;
    }>;
    poll(ownerId: string, taskId: string): Promise<{
        status: string;
        reason?: string;
        bot?: {
            id: number;
            name: string;
            app_id: string;
        };
    }>;
};
