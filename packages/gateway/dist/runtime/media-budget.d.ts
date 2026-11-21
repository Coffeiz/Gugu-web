/** 宿主提供额度，Gateway 统一检查一批实际下载的附件。引用既有附件由存储端核算。 */
export declare function createImMediaBudget(maxBytes: number, maxFiles?: number): {
    readonly remaining: number;
    consume(size: number): boolean;
};
