import type { ProviderTransport } from '@gugu/core/providers';
import { type TelegramPollingOptions } from './polling.js';
export * from './client.js';
export * from './polling.js';
export * from './sender.js';
export declare function createTelegramAdapter(options: {
    token: string;
    transport?: ProviderTransport;
}): {
    api: {
        call: (token: string, method: string, args?: import("./client.js").TelegramCallOptions) => Promise<unknown>;
        downloadFile: (token: string, filePath: string, args?: {
            maxBytes?: number;
            signal?: AbortSignal;
        }) => Promise<Uint8Array>;
        close(): Promise<void>;
    };
    sender: {
        text(target: import("./sender.js").TelegramTarget, text: string, args?: {
            replyMarkup?: Record<string, unknown>;
            signal?: AbortSignal;
            authorize?: () => Promise<boolean>;
        }): Promise<import("./sender.js").TelegramDeliveryReceipt>;
        interaction(target: import("./sender.js").TelegramTarget, prompt: {
            prompt_id: number;
            title?: string;
            body?: string;
            options?: readonly {
                id?: string;
                label?: string;
                token?: string;
            }[];
        }, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<import("./sender.js").TelegramDeliveryReceipt>;
        file(target: import("./sender.js").TelegramTarget, data: Uint8Array, filename: string, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<import("./sender.js").TelegramDeliveryReceipt>;
        draft(target: import("./sender.js").TelegramTarget, text: string, draftId: number, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
        drain(): Promise<void>;
    };
    connect: (options: Omit<TelegramPollingOptions, "api" | "token">) => Promise<import("../contracts.js").GatewayConnection>;
};
