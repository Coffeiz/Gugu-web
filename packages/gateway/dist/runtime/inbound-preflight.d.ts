import type { ImTextChoiceResult } from './interactions/text-choice.js';
import type { ImConversationScope } from '../ir/inbound.js';
/** owner/Bot 必须来自连接配置；chat/user/event 必须来自已验证的平台事件。 */
export interface ImPreflightScope extends ImConversationScope {
    readonly eventId: string;
    /** 正式Gateway仅从永久准入收据的DB时刻注入；直接Host调用可显式不使用准入边界。 */
    readonly admissionCutoff?: string;
}
export interface ImPreflightMessage {
    readonly scope: ImPreflightScope;
    readonly text: string;
    /** 当前、引用媒体及表情均计入；不能为通过文本检查而先下载。 */
    readonly hasPendingMedia: boolean;
    readonly botMentioned: boolean;
    /** 仅接受平台 parser 确认、且指向当前 Bot 的命令。 */
    readonly telegramCommand?: string | null;
}
export type ImSecretStage = {
    readonly status: 'none' | 'replay' | 'ended';
} | {
    readonly status: 'pending_choice' | 'awaiting_secret';
    readonly reference: string;
};
export type ImSecretAction = {
    readonly action: 'start';
} | {
    readonly action: 'cancel';
} | {
    readonly action: 'value';
    readonly value: string;
};
export type ImSecretResult = {
    readonly status: 'awaiting_secret' | 'completed' | 'cancelled' | 'replay' | 'failed';
    readonly fieldLabel?: string;
};
export type ImShortcut = {
    readonly action: 'run' | 'drop';
} | {
    readonly action: 'cancel';
    readonly reply: string;
    readonly reference: string;
} | {
    readonly action: 'no_permission' | 'reply';
    readonly reply: string;
};
export interface ImPreflightPorts {
    /** 每次按完整作用域复核启用、归属和群开关；未知 Telegram 私聊仍可执行绑定。 */
    authorize(scope: ImPreflightScope, signal: AbortSignal): Promise<boolean>;
    /** 只查当前私聊；必须先跨该 scope 的旧 prompt 查重放，再查活动 stage。 */
    inspectSecret(scope: ImPreflightScope, signal: AbortSignal): Promise<ImSecretStage>;
    /** 原子复核 scope/stage/事件幂等并加密暂存；禁止值进入普通历史、日志和恢复 payload。 */
    applySecret(scope: ImPreflightScope, reference: string, action: ImSecretAction, signal: AbortSignal): Promise<ImSecretResult>;
    /** Python QQ 首次私聊绑定规则，必须由既有可信 Bot 服务原子实现。 */
    bindQqOwnerIfUnbound(scope: ImPreflightScope, signal: AbortSignal): Promise<void>;
    consumeBinding(scope: ImPreflightScope, code: string, signal: AbortSignal): Promise<boolean>;
    /** 必须复用统一交互及其恢复事务；不得把数字当成模型确认指令。 */
    consumeTextChoice(scope: ImPreflightScope, text: string, signal: AbortSignal): Promise<ImTextChoiceResult | null>;
    decideShortcut(scope: ImPreflightScope, text: string, signal: AbortSignal): Promise<ImShortcut>;
    /** 必须再次检查活跃 Run 发起者及完整 scope；true 仅表示 durable 取消已写入。 */
    cancel(scope: ImPreflightScope, reference: string, signal: AbortSignal): Promise<boolean>;
    reply(scope: ImPreflightScope, text: string, options: {
        readonly quote: boolean;
        readonly signal: AbortSignal;
    }): Promise<void>;
}
export declare class ImPreflightError extends Error {
    constructor();
}
/** 只生成判定文本，不修改入库原文；只在明确 @ 当前 Bot 时移除一个 mention。 */
export declare function readImAddressedCommand(input: {
    text: string;
    scope: {
        chatType: 'c2c' | 'group';
    };
    botMentioned: boolean;
    qqAtEventOnly?: boolean;
}): {
    semantic: string;
    command: {
        name: string;
        argument: string;
        recognized: boolean;
    } | null;
    unaddressed: {
        name: string;
        argument: string;
        recognized: boolean;
    } | null;
};
export declare function imSemanticText(text: string, botMentioned: boolean): string;
/** 控制消息消费发生在下载、队列和历史之前；所有端口缺失均拒绝启动。 */
export declare function createImInboundPreflight(ports: ImPreflightPorts): (input: ImPreflightMessage, signal: AbortSignal) => Promise<"enqueue" | "consumed">;
