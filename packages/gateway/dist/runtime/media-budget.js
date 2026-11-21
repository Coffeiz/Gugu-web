/** 宿主提供额度，Gateway 统一检查一批实际下载的附件。引用既有附件由存储端核算。 */
export function createImMediaBudget(maxBytes, maxFiles = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxFiles) || maxFiles <= 0)
        throw new RangeError('IM 附件额度无效');
    let bytes = 0;
    let files = 0;
    const remaining = () => files < maxFiles ? maxBytes - bytes : 0;
    return {
        get remaining() { return remaining(); },
        consume(size) {
            if (!Number.isSafeInteger(size) || size <= 0 || size > remaining())
                return false;
            bytes += size;
            files++;
            return true;
        },
    };
}
