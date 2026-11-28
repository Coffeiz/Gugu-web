import { imOwnerCanReadPrivateMemory } from './owner/memory.js'
import { imMemberCanSearchOutsideCurrentGroup } from './member/memory.js'

export interface ImMemorySearchPlanInput {
  isIm: boolean
  chatType: string
  role: string
  requested: string
  hasGroup: boolean
  hasMember: boolean
  mixed?: boolean
}

export type ImMemorySearchPlan =
  | { kind: 'owner'; includeOtherScopes: boolean; storedScopeType: 'group' }
  | { kind: 'member'; includeOtherScopes: true; storedScopeType: 'member' }
  | { kind: 'group'; includeMemberScope: boolean; includeMemberHistory: boolean; includeOtherScopes: boolean; storedScopeType: 'group' | 'member' | null }
  | { kind: 'deny'; reason: 'private_memory' | 'current_group' | 'unavailable' }

/** 统一 IM 记忆检索的角色与范围决策；实际 scope 查询仍由 Host 限定 owner 执行。 */
export function imMemorySearchPlan(input: ImMemorySearchPlanInput): ImMemorySearchPlan {
  const { isIm, chatType, role, requested, hasGroup, hasMember, mixed = false } = input
  if (!isIm) return { kind: 'owner', includeOtherScopes: false, storedScopeType: 'group' }
  if (requested === 'private_memory') {
    if (!mixed && imOwnerCanReadPrivateMemory(role, chatType)) return { kind: 'owner', includeOtherScopes: false, storedScopeType: 'group' }
    return { kind: 'deny', reason: 'private_memory' }
  }
  if (requested === 'current_group' && !hasGroup) return { kind: 'deny', reason: 'current_group' }
  if (role === 'owner' && !hasGroup) {
    return { kind: 'owner', includeOtherScopes: !mixed && (requested === 'auto' || requested === 'all_my_groups'), storedScopeType: 'group' }
  }
  if (role === 'member' && !hasGroup && hasMember) {
    return !mixed && imMemberCanSearchOutsideCurrentGroup(requested)
      ? { kind: 'member', includeOtherScopes: true, storedScopeType: 'member' }
      : { kind: 'deny', reason: 'current_group' }
  }
  if (hasGroup) return { kind: 'group', includeMemberScope: role === 'member' && hasMember && !mixed,
    includeMemberHistory: role === 'member' && hasMember && !mixed,
    includeOtherScopes: requested === 'all_my_groups' && !mixed && role !== 'unknown',
    storedScopeType: role === 'owner' ? 'group' : role === 'member' ? 'member' : null }
  return { kind: 'deny', reason: 'unavailable' }
}
