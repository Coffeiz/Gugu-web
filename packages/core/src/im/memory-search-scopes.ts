import type { ImActor } from './access.js'
import type { AuthorizedMemoryScope } from '../agent/rag/memory-loader.js'
import { MemorySearchAccessError, type MemorySearchScope } from '../agent/rag/memory-search.js'
import { imMemorySearchPlan } from '../agent/scenes/im/memory.js'

export interface ImMemorySearchPolicy { groupMemoryEnabled: boolean; memberMemoryEnabled: boolean }
const deny = (): never => { throw new MemorySearchAccessError('当前身份没有可用的记忆召回范围') }

/** actor来自可信Run；跨群候选来自Host权威cursor，模型只可选择四种范围名称。 */
export function resolveImMemorySearchScopes(actor: ImActor, requested: MemorySearchScope,
  policy: ImMemorySearchPolicy, stored: readonly AuthorizedMemoryScope[] = []): AuthorizedMemoryScope[] {
  if (!actor.ownerId || !actor.botId || !actor.platformUserId || !['qq', 'feishu', 'wechat', 'telegram'].includes(actor.platform)
    || !['group', 'c2c'].includes(actor.chatType) || !['owner', 'member', 'unknown'].includes(actor.role)
    || actor.chatType === 'group' && !actor.chatId || actor.chatType === 'c2c' && actor.chatId !== null || typeof policy.groupMemoryEnabled !== 'boolean'
    || typeof policy.memberMemoryEnabled !== 'boolean' || !['auto', 'current_group', 'all_my_groups', 'private_memory'].includes(requested)) return deny()
  const group = actor.chatType === 'group'
  const mixed = (actor.speakerRoles?.length ?? 0) > 1
  const base = { ownerId: actor.ownerId, platform: actor.platform, botId: actor.botId }
  const owner: AuthorizedMemoryScope = { ownerId: actor.ownerId, type: 'owner', id: actor.ownerId }
  const plan = imMemorySearchPlan({ isIm: true, chatType: actor.chatType, role: actor.role, requested,
    hasGroup: group, hasMember: Boolean(actor.platformUserId), mixed })
  if (plan.kind === 'deny') {
    if (plan.reason === 'current_group' && requested === 'current_group') throw new TypeError('current_group 只能在群聊中使用')
    return deny()
  }
  const result: AuthorizedMemoryScope[] = plan.kind === 'owner' ? [owner] : []
  if (plan.kind === 'group') {
    if (policy.groupMemoryEnabled) result.push({ ...base, type: 'group', id: actor.chatId!, groupId: actor.chatId! })
    if (plan.includeMemberScope && policy.memberMemoryEnabled)
      result.push({ ...base, type: 'member', id: `${actor.chatId}:${actor.platformUserId}`, groupId: actor.chatId! })
  } else if (plan.kind === 'member') {
    // 私聊成员只能读取已授权的个人记忆历史，不允许转到 owner 范围。
  } else return deny()

  const type = plan.storedScopeType
  const enabled = type === 'group' ? policy.groupMemoryEnabled : type === 'member' ? policy.memberMemoryEnabled : false
  if (plan.includeOtherScopes && type && enabled) {
    const limit = plan.kind === 'group' ? 2 : 3, selected: AuthorizedMemoryScope[] = [], seen = new Set<string>()
    for (const candidate of stored) {
      if (candidate.ownerId !== actor.ownerId || candidate.platform !== actor.platform || candidate.botId !== actor.botId
        || candidate.type !== type || !candidate.groupId || !candidate.id
        || candidate.id !== (type === 'group' ? candidate.groupId : `${candidate.groupId}:${actor.platformUserId}`)) return deny()
      if (candidate.groupId === actor.chatId || seen.has(candidate.id)) continue
      seen.add(candidate.id)
      if (selected.length < limit) selected.push({ ...candidate })
    }
    result.push(...selected)
  }
  if (!result.length) return deny()
  return result
}
