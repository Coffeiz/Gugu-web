import type { AttentionDecision, AttentionMode, BotReplyFact } from '@gugu/core/im/attention/types';
export interface ImGroupAttentionInput {
    platform: 'feishu' | 'telegram';
    botId: string;
    groupId: string;
    mode: AttentionMode;
    payload: Readonly<Record<string, unknown>>;
    nowMs?: number;
}
export interface ImGroupAttentionHistoryMessage {
    id: number;
    createdAt: string;
    content: string;
    platformUserId: string | null;
}
export interface ImGroupAttentionHistory {
    messages: readonly ImGroupAttentionHistoryMessage[];
    acceptedFacts: readonly BotReplyFact[];
    complete: boolean;
}
/** Desktop 群聊复用 Core 参与度算法；出站锚点只接受平台已回执并持久化的事实。 */
export declare function createImGroupAttentionGate(): {
    evaluate(input: ImGroupAttentionInput, persistedHistory?: ImGroupAttentionHistory): {
        run: boolean;
        decision: AttentionDecision;
    };
};
