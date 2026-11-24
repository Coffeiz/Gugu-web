export type QqNoticeKind = 'reply' | 'tool' | 'compaction'

/** 原始消息 ID 由宿主按会话范围读取，工具回执必须走被动回复。 */
export function resolveQqNoticeTarget(kind: QqNoticeKind, originalMessageId?: string) {
  if (kind === 'compaction') return { mode: 'active' as const }
  if (!originalMessageId?.trim()) return { mode: 'rejected' as const }
  return { mode: 'passive' as const, messageId: originalMessageId }
}
