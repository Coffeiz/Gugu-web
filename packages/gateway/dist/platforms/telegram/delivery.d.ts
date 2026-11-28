import { type ProviderTransport } from '@gugu/core/providers';
export declare const telegramDocumentLimit = 50000000;
export declare const telegramPhotoLimit = 10000000;
/** 官方 Bot API 只有 URL 路径 Token 认证；固定 origin、无重定向且不暴露底层异常。 */
export declare function createTelegramDeliveryApi(transport: ProviderTransport): {
    sendMessage(token: string, chatId: string, text: string, plainText?: boolean): Promise<boolean>;
    sendAttachment(token: string, chatId: string, file: {
        bytes: Uint8Array;
        filename: string;
        mime: string;
    }): Promise<boolean>;
    verify: (token: string) => Promise<import("./pairing.js").TelegramBotIdentity & {
        webhookUrl: string;
    }>;
};
