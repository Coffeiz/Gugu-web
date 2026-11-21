/** 在WASM加载前只允许完整、有界的标准/腾讯SILK数据帧；不信扩展名或未知头。 */
export declare function prepareSilk(raw: Uint8Array, maximumPcmBytes: number): {
    bytes: Buffer;
    maximumPcmBytes: number;
} | null;
