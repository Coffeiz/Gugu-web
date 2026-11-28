type Element = Record<string, unknown>;
export type FeishuToolEvent = {
    type: 'tool_call' | 'tool_done';
    toolCallId?: string;
    name?: string;
    label?: string;
    status?: string;
    input?: unknown;
    result?: unknown;
};
/** 只允许可信Host为私聊打开详情；脱敏必须沿用正式出站策略。 */
export type FeishuToolSummaryPolicy = {
    chatType: 'group';
    includeDetails?: false;
    sanitize(text: string): string;
} | {
    chatType: 'p2p';
    includeDetails?: boolean;
    sanitize(text: string): string;
};
/** 同一卡片里的正文、图片与工具组；顺序由唯一流消费者维护。 */
export declare class FeishuPresentation {
    private policy?;
    private blocks;
    private nextId;
    private active;
    private locations;
    private visible;
    private omitted;
    readonly embeddedSources: string[];
    used: boolean;
    constructor(policy?: FeishuToolSummaryPolicy | undefined);
    snapshot(): unknown;
    static restore(raw: unknown, policy?: FeishuToolSummaryPolicy): FeishuPresentation;
    copy(): FeishuPresentation;
    get activeId(): string;
    get activeText(): string;
    append(text: string): boolean;
    endRound(): void;
    tool(event: FeishuToolEvent): boolean;
    replace(source: string, key: string): boolean;
    finish(text: string, cancelled: boolean): void;
    elements(): Element[];
    plainText(): string;
    private label;
    private detail;
    private entry;
}
export {};
