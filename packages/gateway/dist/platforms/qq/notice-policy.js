/** 原始消息 ID 由宿主按会话范围读取，工具回执必须走被动回复。 */
export function resolveQqNoticeTarget(kind, originalMessageId) {
    if (kind === 'compaction')
        return { mode: 'active' };
    if (!originalMessageId?.trim())
        return { mode: 'rejected' };
    return { mode: 'passive', messageId: originalMessageId };
}
