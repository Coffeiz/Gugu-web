import type { ImPreflightScope } from '../inbound/preflight.js';
export type ImTextChoiceResult = {
    readonly status: 'awaiting_text' | 'selected' | 'replay' | 'error' | 'question_next';
    readonly text?: string;
};
export interface ImTextChoicePrompt {
    readonly kind: string;
    readonly secret: boolean;
    readonly allowTextInput: boolean;
    readonly customInputActive: boolean;
    /** 保留 schema 声明顺序；已消费选项仍占序号，但 token=null。 */
    readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly token: string | null;
    }[];
}
export declare function selectImTextChoice(prompt: ImTextChoicePrompt, text: string): {
    readonly action: 'option';
    readonly token: string;
} | {
    readonly action: 'text';
} | null;
export interface ScopedImTextPrompt extends ImTextChoicePrompt {
    readonly scope: Omit<ImPreflightScope, 'eventId'>;
    readonly questionIndex?: number;
    readonly promptId: number;
    readonly sessionId: number;
    readonly runId?: string;
}
/** 只将已按 IM 作用域定位的选项交给现有一次性动作/恢复服务，不另造确认。 */
interface ImChoiceReceipt {
    session_id: number;
    prompt_id: number;
    result: {
        status?: unknown;
        text?: unknown;
    };
}
export declare function createImTextChoiceConsumer(options: {
    service?: {
        respond?(ownerId: string, promptId: number, token: string, eventId?: string): Promise<ImChoiceReceipt>;
        resumeText?(ownerId: string, promptId: number, text: string, eventId?: string, questionIndex?: number): Promise<ImChoiceReceipt>;
    };
    consumeText?(prompt: ScopedImTextPrompt, text: string, scope: ImPreflightScope, signal: AbortSignal): Promise<ImChoiceReceipt>;
    /** 最近活动 choice/confirm 优先，然后可接收文本的 prompt；必须绑定完整 session scope。 */
    find(scope: ImPreflightScope, signal: AbortSignal, text?: string): Promise<readonly ScopedImTextPrompt[] | {
        readonly replayed: true;
    }>;
    /** 临执行再次检查可信 Bot/作用域和 prompt-session 绑定；不能只按 owner 查询。 */
    authorize(scope: ImPreflightScope, promptId: number, sessionId: number, signal: AbortSignal): Promise<boolean>;
}): (scope: ImPreflightScope, text: string, signal: AbortSignal) => Promise<ImTextChoiceResult | null>;
export {};
