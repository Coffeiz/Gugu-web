import { type AsrDependencies, type ProviderConfig, type ProviderTransport } from '@gugu/core/providers';
export interface ImVoiceInput {
    bytes: Uint8Array;
    mime: string;
    ext: string;
}
export interface ImVoiceSelection {
    readonly ownerId: string;
    readonly version: string;
    readonly configured: boolean;
    readonly config: Readonly<ProviderConfig> | null;
    readonly profile: {
        readonly maxFileBytes: number;
    };
    authorizeCurrent(): Promise<boolean>;
}
export interface ImVoiceSelectionPort {
    select(ownerId: string, signal: AbortSignal): Promise<ImVoiceSelection>;
}
export interface ImVoiceTranscriberOptions<TInput extends ImVoiceInput = ImVoiceInput> {
    ownerId: string;
    voice: ImVoiceSelectionPort;
    authorize(): Promise<boolean>;
    createTransport(config: ProviderConfig): Promise<{
        transport: ProviderTransport;
        close?(): Promise<void>;
    }> | {
        transport: ProviderTransport;
        close?(): Promise<void>;
    };
    diagnose(code: 'im_voice_failed'): void;
    audio?: Pick<AsrDependencies, 'toWav' | 'probeAudioDuration'>;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    reuse?(input: TInput, selected: ImVoiceSelection, signal: AbortSignal): Promise<{
        text: string;
    } | null>;
    raiseErrors?: boolean;
}
export interface ImNativeVoiceTranscript {
    text: string | null;
    status: 'completed' | 'empty' | 'failed';
}
export declare class ImVoiceRuntimeError extends Error {
    readonly code: 'unauthorized' | 'cleanup' | 'media_limit';
    constructor(code: 'unauthorized' | 'cleanup' | 'media_limit');
}
export declare const IM_VOICE_MAX_NATIVE_BYTES: number;
export declare function createImVoiceAccess(options: Pick<ImVoiceTranscriberOptions, 'authorize' | 'diagnose'>): {
    capture: <T extends ImVoiceInput>(input: T) => T;
    runAllowed: (signal: AbortSignal, authorize?: () => Promise<boolean>) => Promise<void>;
    report: () => void;
};
/** 两个宿主共用授权复核、模型选择固定期、音频限制、ASR 请求及资源关闭策略。 */
export declare function createImVoiceTranscriber<TInput extends ImVoiceInput = ImVoiceInput>(options: ImVoiceTranscriberOptions<TInput>): {
    transcribe(input: TInput, signal?: AbortSignal, authorizeRequest?: () => Promise<boolean>): Promise<string | null>;
    transcribeSelected(input: TInput, selected: ImVoiceSelection, signal?: AbortSignal, authorizeRequest?: () => Promise<boolean>): Promise<string | null>;
};
