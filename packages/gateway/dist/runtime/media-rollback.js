/** 回收本批创建的附件，单个回收失败时仍继续处理剩余附件。 */
export async function rollbackImMedia(created, release) {
    let success = true;
    for (const attachment of [...created].reverse()) {
        try {
            await release(attachment);
        }
        catch {
            success = false;
        }
    }
    return success;
}
