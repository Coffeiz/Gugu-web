import { type ImLinkButtonSender, type LinkButton } from '@gugu/core/tools';
import type { createQqSender } from '../platforms/qq/sender.js';
import type { createFeishuSender } from '../platforms/feishu/sender.js';
import type { createTelegramSender } from '../platforms/telegram/sender.js';
import type { createWechatSender } from '../platforms/wechat/sender.js';
export type ImLinkButtonWire = {
    platform: 'qq';
    sender: Partial<Pick<ReturnType<typeof createQqSender>, 'linkButtons'>>;
} | {
    platform: 'feishu';
    sender: Partial<Pick<ReturnType<typeof createFeishuSender>, 'linkCard' | 'text'>>;
} | {
    platform: 'telegram';
    sender: Partial<Pick<ReturnType<typeof createTelegramSender>, 'text'>>;
} | {
    platform: 'wechat';
    sender: Partial<Pick<ReturnType<typeof createWechatSender>, 'text'>>;
};
export declare function sendImLinkButtons(input: {
    wire: ImLinkButtonWire;
    recipient: string;
    chatType: 'c2c' | 'group';
    contextToken?: string;
    message: string;
    buttons: LinkButton[];
    signal: AbortSignal;
    authorize(): Promise<boolean>;
}): ReturnType<ImLinkButtonSender['send']>;
