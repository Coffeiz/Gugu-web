/** Member 仅可检索其被授权的群/平台用户记忆范围。 */
export function imMemberCanSearchOutsideCurrentGroup(requested: string): boolean {
  return requested === 'auto' || requested === 'all_my_groups'
}

export function imMemberCanReflectMemory(role: string, enabled: boolean): boolean {
  return role === 'member' && enabled
}
