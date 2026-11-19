import type { ContextDataPorts, Json, RunIdentity } from '@gugu/core/agent'
import type { ImActor } from '@gugu/core/im/access'
import { createLocalImMemoryMaintenanceStorage, imMemoryMaintenanceScopeFileKey } from '../../admin/memory-apply.js'

export type ImMemoryReadScope = Parameters<typeof imMemoryMaintenanceScopeFileKey>[0]
export interface ImMemoryReadAuthorization {
  ownerId: string; botId: string; platform: ImActor['platform']; chatType: ImActor['chatType']
  chatId: string | null; platformUserId: string
  groupMemoryEnabled: boolean; memberMemoryEnabled: boolean
}
export class ImMemorySourceError extends Error {
  constructor(readonly code: 'invalid_scope' | 'unauthorized' | 'unavailable' | 'invalid_data' | 'aborted') {
    super('IM 记忆读取不可用'); this.name = 'ImMemorySourceError'
  }
}

/** 当前 Run 的只读本地 IM scope 数据源；从不读取 owner 长期记忆、daily 或其他群/成员资料。 */
export function createLocalImMemorySource(options: {
  root: string; identity: RunIdentity; actor: ImActor
  /** 必须查询当前 Bot 开关并复核当前 actor 权限；不接受入站 payload 中自报的开关。 */
  authorize(identity: RunIdentity, actor: ImActor): Promise<ImMemoryReadAuthorization | null>
  /** 与既有 scope 删除/维护共享墓碑来源。 */
  isTombstoned(scope: ImMemoryReadScope): Promise<boolean>
}): Pick<ContextDataPorts, 'loadImMemory'> {
  const identity = Object.freeze({ ...options.identity }), actor = structuredClone(options.actor)
  if (typeof options.root !== 'string' || !options.root.trim() || !identity.ownerId || !identity.runId || !/^[1-9]\d*$/.test(identity.sessionId) || actor.ownerId !== identity.ownerId
    || !['feishu', 'qq', 'wechat', 'telegram'].includes(actor.platform) || !/^[1-9]\d*$/.test(actor.botId)
    || !actor.platformUserId || !['owner', 'member', 'unknown'].includes(actor.role)
    || !['c2c', 'group'].includes(actor.chatType) || (actor.chatType === 'group' ? !actor.chatId : actor.chatId !== null))
    throw new ImMemorySourceError('invalid_scope')
  const base = { owner_user_id: actor.ownerId, platform: actor.platform, bot_id: actor.botId }
  const group: ImMemoryReadScope | null = actor.chatType === 'group' ? { ...base, scope_type: 'group', scope_id: actor.chatId! } : null
  // Python member_scope_id：群与成员共同组成现有 scope_id，私聊沿用平台用户 id。
  const member: ImMemoryReadScope = { ...base, scope_type: 'platform-user',
    scope_id: group ? `${actor.chatId!.trim()}:${actor.platformUserId.trim()}` : actor.platformUserId }
  try {
    for (const scope of [group, member]) if (scope) imMemoryMaintenanceScopeFileKey(scope, 'summary.json')
  } catch { throw new ImMemorySourceError('invalid_scope') }
  const storage = createLocalImMemoryMaintenanceStorage(options.root)
  const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new ImMemorySourceError('aborted') }
  async function authorize(signal?: AbortSignal) {
    checkAbort(signal)
    const current = await options.authorize(identity, structuredClone(actor))
    if (!current || current.ownerId !== actor.ownerId || current.botId !== actor.botId || current.platform !== actor.platform
      || current.chatType !== actor.chatType || current.chatId !== actor.chatId || current.platformUserId !== actor.platformUserId
      || typeof current.groupMemoryEnabled !== 'boolean' || typeof current.memberMemoryEnabled !== 'boolean') throw new ImMemorySourceError('unauthorized')
    checkAbort(signal)
    return current
  }
  async function read(scope: ImMemoryReadScope, fields: readonly string[], signal?: AbortSignal): Promise<Record<string, Json> | null> {
    checkAbort(signal)
    if (await options.isTombstoned({ ...scope })) return null
    const result: Record<string, Json> = {}
    for (const field of fields) {
      checkAbort(signal)
      const text = await storage.read(imMemoryMaintenanceScopeFileKey(scope, `${field}.json`))
      if (text === null) result[field] = {}
      else {
        let value: unknown
        try { value = JSON.parse(text) }
        catch { throw new ImMemorySourceError('invalid_data') }
        if (!value || typeof value !== 'object') throw new ImMemorySourceError('invalid_data')
        result[field] = value as Json
      }
    }
    checkAbort(signal)
    return result
  }
  return {
    async loadImMemory(candidate, signal) {
      if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId
        || 'runId' in candidate && candidate.runId !== identity.runId) throw new ImMemorySourceError('invalid_scope')
      try {
        const before = await authorize(signal), result: Record<string, Json> = {}
        if (group && before.groupMemoryEnabled) {
          const value = await read(group, ['summary', 'profile'], signal)
          if (value) result.group = value
        }
        // Python 仅 member 读取个人 scope；owner/unknown 不读取，即便它们是受限上下文。
        if (actor.role === 'member' && before.memberMemoryEnabled) {
          const value = await read(member, ['summary', 'profile', 'pattern'], signal)
          if (value) result.platform_user = value
        }
        if (result.group && await options.isTombstoned({ ...group! })) delete result.group
        if (result.platform_user && await options.isTombstoned({ ...member })) delete result.platform_user
        const after = await authorize(signal)
        if (result.group && !after.groupMemoryEnabled || result.platform_user && !after.memberMemoryEnabled)
          throw new ImMemorySourceError('unauthorized')
        checkAbort(signal)
        return result
      } catch (error) {
        if (error instanceof ImMemorySourceError) throw error
        throw new ImMemorySourceError('unavailable')
      }
    },
  }
}
