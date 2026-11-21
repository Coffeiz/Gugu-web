import type { ImConversationScope } from './inbound.js';
export declare function createImRequestedReply(scope: ImConversationScope, input: {
    ownerId: string;
    deliveryId: string;
    text: string;
}, originalMessageId?: string): Readonly<{
    version: 1;
    kind: "reply.requested";
    scope: Readonly<{
        ownerId: string;
        botId: string;
        platform: "feishu" | "qq" | "wechat" | "telegram";
        chatType: "c2c" | "group";
        chatId: string | null;
        platformUserId: string;
    }>;
    deliveryId: string;
    text: string;
    recipient: string;
    originalMessageId: string | undefined;
}> | null;
