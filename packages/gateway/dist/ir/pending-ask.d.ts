/** 飞书与 Telegram 群聊 ASK 的共享延迟策略；存储和唤醒由宿主适配。 */
export declare const IM_PENDING_ASK_MIN_WAIT_MS = 60000;
export declare const IM_PENDING_ASK_QUIET_MS = 30000;
export declare const IM_PENDING_ASK_MAX_WAIT_MS = 180000;
export interface ImPendingAskClock {
    startedAt: number;
    latestAskAt: number;
    latestActivityAt: number;
}
export interface ImPendingAskScope {
    ownerId: string;
    botId: string;
    platform: 'qq' | 'feishu' | 'telegram';
    groupId: string;
}
export interface ImPendingAskTrigger {
    eventId: string;
    eventMs: number;
    platformMessageId: string;
    senderId: string;
    payload: Readonly<Record<string, unknown>>;
}
export interface ImPendingAskResume {
    scope: ImPendingAskScope;
    trigger: ImPendingAskTrigger;
    resumeId: string;
    latestAskMs: number;
}
export interface ImPendingAskStore {
    register(scope: ImPendingAskScope, trigger: ImPendingAskTrigger, signal?: AbortSignal): Promise<string | null>;
    observe(scope: ImPendingAskScope, event: {
        eventMs: number;
        senderId: string;
        ownBotId?: string;
        replyTo?: string;
        directMention?: boolean;
    }, signal?: AbortSignal): Promise<void>;
    cancel(scope: ImPendingAskScope, eventMs: number, signal?: AbortSignal): Promise<void>;
    isCurrent(resume: ImPendingAskResume, signal?: AbortSignal): Promise<boolean>;
    isCancelled(resume: ImPendingAskResume, signal?: AbortSignal): Promise<boolean>;
    claimDue(limit?: number, signal?: AbortSignal): Promise<ImPendingAskResume[]>;
    complete(resume: ImPendingAskResume, signal?: AbortSignal): Promise<boolean>;
}
/** 最后一条 ASK 至少等待一分钟，群安静三十秒后唤醒，最长等待三分钟。 */
export declare function imPendingAskDueAt(state: ImPendingAskClock): number;
export declare function isImPendingAskReady(state: ImPendingAskClock, now: number): boolean;
/** 各宿主共用唤醒顺序；存储负责 claim/CAS，宿主负责重新授权和派发。 */
export declare function pumpImPendingAsks(options: {
    store: ImPendingAskStore;
    authorize(resume: ImPendingAskResume, signal: AbortSignal): Promise<boolean>;
    dispatch(resume: ImPendingAskResume, signal: AbortSignal): Promise<void>;
}, signal: AbortSignal): Promise<number>;
