/** 音频/视频共用的实际进程边界；关闭并排空stdio之后才释放调用者临时目录。 */
export declare function runImMediaProcess(options: {
    binary: string;
    args: string[];
    directory: string;
    maxOutputBytes: number;
    timeoutMs: number;
    signal: AbortSignal;
    input?: Uint8Array;
    cancelled(): Error;
}): Promise<Buffer | null>;
