export interface TelegramBotIdentity {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
    webhookUrl?: string;
}
type TelegramIdentityCall = (method: 'getMe' | 'getWebhookInfo') => Promise<unknown>;
/** 校验机器人身份和 Webhook 状态，供连接设置和轮询启动共用。 */
export declare function verifyTelegramBotIdentity(call: TelegramIdentityCall, expectedId?: string): Promise<TelegramBotIdentity & {
    webhookUrl: string;
}>;
export {};
