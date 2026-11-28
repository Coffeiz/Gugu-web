import { imOwnerCanReadPrivateMemory } from './owner/memory.js'
import { imMemberCanSearchOutsideCurrentGroup } from './member/memory.js'

export interface ImMemorySearchPlanInput {
  isIm: boolean
  chatType: string
  role: string
  requested: string
  hasGroup: boolean
  hasMember: boolean
}

export type ImMemorySearchPlan =
  | { kind: 'owner'; includeOtherScopes: boolean }
  | { kind: 'member' }
  | { kind: 'group'; includeMemberScope: boolean; includeMemberHistory: boolean; includeOtherScopes: boolean }
  | { kind: 'deny'; reason: 'private_memory' | 'current_group' | 'unavailable' }

/** 统一 IM 记忆检索的角色与范围决策；实际 scope 查询仍由 Host 限定 owner 执行。 */
export function imMemorySearchPlan(input: ImMemorySearchPlanInput): ImMemorySearchPlan {
  const { isIm, chatType, role, requested, hasGroup, hasMember } = input
  if (!isIm) return { kind: 'owner', includeOtherScopes: false }
  if (requested === 'private_memory') {
    if (imOwnerCanReadPrivateMemory(role, chatType)) return { kind: 'owner', includeOtherScopes: false }
    return { kind: 'deny', reason: 'private_memory' }
  }
  if (requested === 'current_group' && !hasGroup) return { kind: 'deny', reason: 'current_group' }
  if (role === 'owner' && !hasGroup) {
    return { kind: 'owner', includeOtherScopes: requested === 'auto' || requested === 'all_my_groups' }
  }
  if (role === 'member' && !hasGroup && hasMember) {
    return imMemberCanSearchOutsideCurrentGroup(requested)
      ? { kind: 'member' }
      : { kind: 'deny', reason: 'current_group' }
  }
  if (hasGroup) return { kind: 'group', includeMemberScope: role === 'member',
    includeMemberHistory: role === 'member' && hasMember,
    includeOtherScopes: requested === 'all_my_groups' }
  return { kind: 'deny', reason: 'unavailable' }
}
