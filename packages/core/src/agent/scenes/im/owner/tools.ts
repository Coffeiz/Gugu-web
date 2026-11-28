import type { ImActor } from '../../../../im/access.js'

export function isVerifiedImOwner(actor: Pick<ImActor, 'role' | 'verifiedOwner'>): boolean {
  return actor.role === 'owner' && actor.verifiedOwner
}

/** 仅在已验证的 owner 私聊中注入 owner 上下文。 */
export function imOwnerPrivate(actor: Pick<ImActor, 'role' | 'chatType' | 'verifiedOwner'>): boolean {
  return isVerifiedImOwner(actor) && actor.chatType === 'c2c'
}

export const imFilePathPermission = 'send_item:path'

/** Owner 使用宿主已装配的工具，渠道限制由共享 IM 入口统一判断。 */
export function imOwnerAllowsTool(platform: ImActor['platform'], name: string): boolean {
  return name !== 'react' || platform === 'feishu'
}
