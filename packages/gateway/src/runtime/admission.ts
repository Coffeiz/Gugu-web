import type { ImConversationScope } from '../ir/inbound.js'

export type ImAdmissionScope = ImConversationScope & { readonly eventId: string }

export class ImGatewayAdmissionError extends Error {
  readonly code: 'invalid_input' | 'unauthorized' | 'conflict' | 'pending' | 'unknown' | 'unavailable'

  constructor(code: ImGatewayAdmissionError['code']) {
    super('IM 入站准入尚未完成')
    this.code = code
    this.name = 'ImGatewayAdmissionError'
  }
}

export function requireImAdmissionId(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/u.test(value))
    throw new ImGatewayAdmissionError('invalid_input')
  return value
}

/** 宿主提供带域隔离的摘要函数，避免把平台原生标识保存为可见键。 */
export function imAdmissionKeys(scope: ImAdmissionScope, digest: (value: unknown) => string) {
  if (!['feishu', 'qq', 'wechat', 'telegram'].includes(scope.platform)
    || !['group', 'c2c'].includes(scope.chatType)
    || (scope.chatType === 'c2c' && scope.chatId !== null))
    throw new ImGatewayAdmissionError('invalid_input')
  const sender = requireImAdmissionId(scope.platformUserId, 256)
  const conversation = scope.chatType === 'group' ? requireImAdmissionId(scope.chatId, 256) : sender
  const scopeHash = digest([scope.ownerId, scope.platform, scope.botId, scope.chatType, conversation])
  const eventHash = digest([scopeHash, sender, requireImAdmissionId(scope.eventId)])
  return { scopeHash, eventHash }
}
