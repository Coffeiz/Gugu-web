export declare function imMediaFilename(value: string): {
    name: string;
    ext: string;
};
export declare function imImageFormat(bytes: Uint8Array): {
    ext: string;
    mime: string;
} | null;
