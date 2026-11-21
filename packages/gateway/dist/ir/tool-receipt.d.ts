export interface ImToolReceipt {
    display?: unknown;
    name?: string;
    label?: string;
    status?: string;
    result?: unknown;
}
/** 展示已提交的工具状态。只读取明确允许展示的投递状态，不输出工具参数或原始结果。 */
export declare function formatImToolReceipt(event: ImToolReceipt, sanitize: (label: string) => string): string;
