import { casefoldSearchText } from '@gugu/search'
import type { AttentionMessage } from './types.js'

/** 与 Python 相同的 NFKC/casefold 相似度视图，标点与空白不参与匹配。 */
export function normalizeAttentionText(text: string): string {
  return [...casefoldSearchText(String(text || '').normalize('NFKC'))]
    .filter(char => /[\p{L}\p{N}]/u.test(char)).join('')
}

/** 保留最新同 ID 事实，按可信事件时间排序，不拼接相邻附件文本。 */
export function buildLogicalCandidates(messages: readonly AttentionMessage[]): AttentionMessage[] {
  const byId = new Map(messages.map(message => [message.eventId, message]))
  return [...byId.values()]
    .sort((a, b) => a.eventReceivedMs - b.eventReceivedMs || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
    .map(message => ({ ...message, candidateText: message.rawText }))
}
