import { createHash } from 'node:crypto'
import type { PortableValue } from '@gugu/core/agent'
import type { ImAttachmentScope } from '../inbound/attachments.js'

export interface ImAcceptedSource {
  readonly sourceEventIds: readonly string[]
  readonly sourceMessageIds: readonly string[]
  readonly sourceEventIdsComplete: boolean
}
/** 只投影实际平台成功回执；由共享receipts事务持久化，不在sender中单独记账。 */
export function imAcceptedEvidence(input: { scope: ImAttachmentScope; recipient: string; kind: 'text' | 'artifact' | 'interaction';
  source: ImAcceptedSource; receipt: { outcome: 'accepted' | 'rejected' | 'unknown'; platformMessageIds?: readonly string[] }; text?: string; bytes?: Uint8Array }) {
  if (input.receipt.outcome !== 'accepted') return input.receipt.outcome
  const ids = [...(input.receipt.platformMessageIds ?? [])]
  // 微信协议没有返回原生message ID；不能把context_token或自造client_id冒充平台送达ID。
  if (input.scope.platform !== 'wechat' && (!ids.length || ids.some(id => typeof id !== 'string' || !id))) return 'unknown' as const
  const evidence: PortableValue = {
    v: 1, scope: { ownerId: input.scope.ownerId, botId: input.scope.botId, platform: input.scope.platform,
      chatType: input.scope.chatType, chatId: input.scope.chatId }, recipient: input.recipient, kind: input.kind,
    platformMessageIds: ids, sourceEventIds: [...input.source.sourceEventIds], sourceMessageIds: [...input.source.sourceMessageIds],
    coverage: { nativeMessageIds: input.scope.platform !== 'wechat', sourceEventIds: input.source.sourceEventIdsComplete },
    // ledger正文预算按UTF-8计；超限只留完整内容hash，不能截断后冒充完整可见正文。
    ...(input.text !== undefined && Buffer.byteLength(input.text) <= 48000 ? { text: input.text } : {}),
    ...(input.text !== undefined || input.bytes !== undefined ? { contentHash: createHash('sha256').update(input.text ?? input.bytes!).digest('hex') } : {}),
  }
  return { outcome: 'accepted' as const, evidence }
}
