import { type createFeishuClient } from './client.js';
type ObjectValue = Record<string, unknown>;
type Outcome = 'accepted' | 'rejected' | 'unknown';
export interface FeishuDeliveryReceipt {
    outcome: Outcome;
    platformMessageIds: readonly string[];
}
export interface FeishuPrompt {
    prompt_id: number;
    title?: string;
    body?: string;
    options?: readonly {
        id?: string;
        label?: string;
        token?: string;
    }[];
}
export declare function feishuFileType(ext: string): string;
/** 普通卡片与Python一致：表格为原生组件，只有首个Markdown拥有streaming element_id。 */
export declare function buildFeishuCardElements(text: string): ObjectValue[];
export declare function createFeishuSender(options: {
    client: Pick<ReturnType<typeof createFeishuClient>, 'call'>;
}): {
    text(receiveId: string, text: string, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<FeishuDeliveryReceipt>;
    card(receiveId: string, payload: ObjectValue, signal?: AbortSignal): Promise<FeishuDeliveryReceipt>;
    interaction(receiveId: string, prompt: FeishuPrompt, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<FeishuDeliveryReceipt>;
    linkCard(receiveId: string, text: string, buttons: readonly {
        label: string;
        url: string;
    }[], signal?: AbortSignal): Promise<FeishuDeliveryReceipt>;
    uploadImage: (data: Uint8Array, signal?: AbortSignal, authorize?: () => Promise<boolean>) => Promise<{
        outcome: Outcome;
        imageKey: string | null;
    }>;
    file(chatId: string, data: Uint8Array, name: string, ext: string, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<FeishuDeliveryReceipt>;
    react(messageId: string, emojiType: string, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<{
        outcome: Outcome;
        reactionId: string | null;
    }>;
};
export {};
