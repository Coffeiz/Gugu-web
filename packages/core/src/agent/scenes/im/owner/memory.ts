/** 群内 owner 记忆读取须由已验证身份和群设置共同允许。 */
export function imOwnerCanReadGroupMemory(role: string, verifiedOwner: boolean, enabled: boolean): boolean {
  return role === 'owner' && verifiedOwner && enabled
}

/** 私人记忆仅允许 owner 私聊读取。 */
export function imOwnerCanReadPrivateMemory(role: string, chatType: string): boolean {
  return role === 'owner' && chatType !== 'group'
}

/** IM 记忆维护任务沿用现有 owner/verifiedOwner 接受条件。 */
export function imOwnerMemoryMaintenanceAllowed(role: string, verifiedOwner: boolean): boolean {
  return role === 'owner' || verifiedOwner
}
