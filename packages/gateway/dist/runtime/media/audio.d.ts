import type { AsrDependencies } from '@gugu/core/providers';
export declare class ImAudioCleanupError extends Error {
    constructor();
}
/** 实际安全进程边界；与Core ASR dependencies同签名，不负责选模、密钥或网络。 */
export declare function createImAudioProcessor(options?: {
    nodePath?: string;
    ffmpegPath?: string;
    ffprobePath?: string;
    temporaryRoot?: string;
    maxInputBytes?: number;
    maxOutputBytes?: number;
    probeTimeoutMs?: number;
    transcodeTimeoutMs?: number;
    maxConcurrent?: number;
}): Pick<AsrDependencies, 'probeAudioDuration' | 'toWav'>;
