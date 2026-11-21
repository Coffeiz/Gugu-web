import { type ParsedQqMessage, type QqEmojiRef } from './message.js';
type Value = Record<string, unknown>;
type QqScope = {
    platform: string;
    ownerId: string;
    botId: string;
    chatType: string;
    platformUserId: string;
    chatId: string | null;
};
export declare function createQqInboundPreparation<Scope extends QqScope>(options: {
    authorize(scope: Scope, signal: AbortSignal): Promise<boolean>;
    appendAssets(message: ParsedQqMessage, signal: AbortSignal): Promise<void>;
    references: {
        remember(scope: Scope, index: string, entry: Value, signal: AbortSignal): Promise<void>;
        read(scope: Scope, index: string, signal: AbortSignal): Promise<Value | null>;
        queueFace(scope: Scope, eventId: string, refs: readonly QqEmojiRef[], signal: AbortSignal): Promise<void>;
        takeFace(scope: Scope, eventId: string, signal: AbortSignal): Promise<QqEmojiRef[]>;
    };
}): {
    prepare: (scope: Scope, input: ParsedQqMessage, signal: AbortSignal) => Promise<ParsedQqMessage | null>;
    close(): void;
};
export declare const QQ_REFERENCE_TTL_SECONDS: number;
export declare const QQ_REFERENCE_MAX_ENTRIES = 50000;
export declare const QQ_FACE_PENDING_MS = 3000;
export {};
