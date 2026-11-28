import type { ImConversationScope } from './inbound.js'

export function createImRequestedReply(
  scope: ImConversationScope,
  input: { ownerId: string; deliveryId: string; text: string },
  originalMessageId?: string,
) {
  if (!scope.ownerId || scope.ownerId !== input.ownerId || !scope.botId || !scope.platformUserId
    || !input.deliveryId || typeof input.text !== 'string' || !input.text) return null
  const recipient = scope.chatType === 'group' ? scope.chatId : scope.platformUserId
  if (!recipient) return null
  return Object.freeze({
    version: 1 as const,
    kind: 'reply.requested' as const,
    scope: Object.freeze({ ...scope }),
    deliveryId: input.deliveryId,
    text: input.text,
    recipient,
    originalMessageId,
  })
}
