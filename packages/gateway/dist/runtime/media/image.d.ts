import type { MediaLimits } from '@gugu/core/providers';
export interface ImImageInput {
    bytes: Uint8Array;
    ext: string;
    mime?: string;
}
export interface ImProcessedImage {
    bytes: Uint8Array;
    mime: string;
    width: number;
    height: number;
}
export declare class ImImageCleanupError extends Error {
    constructor();
}
export declare const IM_IMAGE_MAX_INPUT_BYTES: number;
/** 只生成Provider输入副本；不会重写原附件、稳定ref、ID或文件元数据。 */
export declare function createImImageProcessor(options?: {
    ffmpegPath?: string;
    temporaryRoot?: string;
    maxInputBytes?: number;
    maxOutputBytes?: number;
    maxPixels?: number;
    timeoutMs?: number;
    maxConcurrent?: number;
}): {
    fit(input: ImImageInput, limits: MediaLimits, signal: AbortSignal): Promise<ImProcessedImage | null>;
};
