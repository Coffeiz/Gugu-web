import { type TelegramCallOptions } from './client.js';
export interface TelegramTarget {
    chatId: string;
    chatType: 'group' | 'c2c';
    replyToMessageId?: string;
}
export interface TelegramDeliveryReceipt {
    outcome: 'accepted' | 'rejected' | 'unknown';
    platformMessageIds: readonly string[];
}
export interface TelegramSendingApi {
    call(token: string, method: string, options?: TelegramCallOptions): Promise<unknown>;
}
/** 每 Bot 一个实例，跨 chat 串行维护 bot/chat 限速；未知结果不自动重试。 */
export declare function createTelegramSender(options: {
    token: string;
    api: TelegramSendingApi;
    now?(): number;
    sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}): {
    text(target: TelegramTarget, text: string, args?: {
        replyMarkup?: Record<string, unknown>;
        signal?: AbortSignal;
        authorize?: () => Promise<boolean>;
    }): Promise<TelegramDeliveryReceipt>;
    interaction(target: TelegramTarget, prompt: {
        prompt_id: number;
        title?: string;
        body?: string;
        options?: readonly {
            id?: string;
            label?: string;
            token?: string;
        }[];
    }, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<TelegramDeliveryReceipt>;
    file(target: TelegramTarget, data: Uint8Array, filename: string, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<TelegramDeliveryReceipt>;
    draft(target: TelegramTarget, text: string, draftId: number, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<boolean>;
    drain(): Promise<void>;
};
