import type { createILinkClient } from './client.js';
import type { createWechatMedia } from './media.js';
import type { RunEvent } from '@gugu/core/agent';
import { type WechatTypingOptions } from './typing.js';
/** 由Host可信运行绑定解析；contextToken是秘密，只能在内存和受控平台请求中使用。 */
export interface WechatSendTarget {
    readonly userId: string;
    readonly contextToken: string;
    readonly typingTicket?: string;
}
export interface WechatSendReceipt {
    readonly outcome: 'accepted' | 'rejected' | 'unknown';
}
/** 单Bot出站组合器；同一用户的文本和媒体串行，Host负责绑定授权及client/media生命周期。 */
export declare function createWechatSender(options: {
    client: Pick<ReturnType<typeof createILinkClient>, 'sendMessage'> & Partial<Pick<ReturnType<typeof createILinkClient>, 'getConfig' | 'sendTyping'>>;
    media: Pick<ReturnType<typeof createWechatMedia>, 'prepareItem'>;
    generateId?(): string;
    typing?: WechatTypingOptions;
}): {
    text(target: WechatSendTarget, value: string, signal?: AbortSignal, authorize?: () => Promise<boolean>, deliveryId?: string): Promise<WechatSendReceipt>;
    image(target: WechatSendTarget, bytes: Uint8Array, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<WechatSendReceipt>;
    file(target: WechatSendTarget, bytes: Uint8Array, fileName: string, signal?: AbortSignal, authorize?: () => Promise<boolean>): Promise<WechatSendReceipt>;
    idle(): Promise<void>;
    startTyping: (target: WechatSendTarget, authorize: () => Promise<boolean>, signal?: AbortSignal) => Promise<{
        status: "started";
        indicator: {
            isRunning(): boolean;
            start(): Promise<void>;
            stop(): Promise<"stopped" | "unknown">;
        };
    } | {
        status: "unavailable";
        reason: "not_configured" | "unauthorized" | "invalid_target" | "cancelled" | "empty_ticket" | "api_failed" | "closed";
    }>;
    stopTyping: (target: WechatSendTarget) => Promise<"unknown" | "stopped">;
    /** 只迭代实际Run一次；未读到运行事件不启动，平台故障不吞业务生成器异常。 */
    observeRun(target: WechatSendTarget, events: AsyncIterable<RunEvent>, authorize: () => Promise<boolean>, signal?: AbortSignal): AsyncGenerator<RunEvent>;
    close(): Promise<void>;
};
