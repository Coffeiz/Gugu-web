import type { Json, RunIdentity } from '../agent/models.js'
import type { ContextDataPorts } from '../agent/ports.js'
import type { ImActor } from './access.js'

export interface ImMemoryScopeFile {
  owner_user_id: string
  platform: ImActor['platform']
  bot_id: string
  scope_type: 'group' | 'platform-user'
  scope_id: string
}

const allowedFiles: Record<ImMemoryScopeFile['scope_type'], readonly string[]> = {
  group: ['profile.json', 'summary.json', 'daily.md', 'memory.md', 'members.json'],
  'platform-user': ['profile.json', 'pattern.json', 'summary.json', 'daily.md', 'memory.md'],
}

function requiredComponent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..' || /[/\\\0]/u.test(value))
    throw new TypeError('IM 记忆范围无效')
  return value
}

/** Web Host 与 Desktop 共用的 IM 记忆文件布局，宿主仅负责受限文件读写。 */
export function imMemoryScopeFileKey(scope: ImMemoryScopeFile, filename: string): string {
  const owner = requiredComponent(scope.owner_user_id), bot = requiredComponent(scope.bot_id)
  const id = requiredComponent(scope.scope_id)
  if (!['qq', 'feishu', 'wechat', 'telegram'].includes(scope.platform)
    || !Object.hasOwn(allowedFiles, scope.scope_type) || !allowedFiles[scope.scope_type].includes(filename))
    throw new TypeError('IM 记忆范围无效')
  const branch = scope.scope_type === 'group' ? 'groups' : 'platform-users'
  const quote = (value: string) => encodeURIComponent(value).replace(/[!'()*]/gu,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return [quote(owner), '.agent', 'memories', 'im', quote(scope.platform), quote(bot), branch, quote(id), filename].join('/')
}

export interface ImMemoryReadAuthorization {
  ownerId: string
  botId: string
  platform: ImActor['platform']
  chatType: ImActor['chatType']
  chatId: string | null
  platformUserId: string
  groupMemoryEnabled: boolean
  memberMemoryEnabled: boolean
  groupOwnerMemoryEnabled: boolean
}

export class ImMemorySourceError extends Error {
  constructor(readonly code: 'invalid_scope' | 'unauthorized' | 'unavailable' | 'invalid_data' | 'aborted') {
    super('IM 记忆读取不可用')
    this.name = 'ImMemorySourceError'
  }
}

/**
 * Scope 解析、配置复核、墓碑检查和字段白名单属于共享策略；Web/Desktop 注入各自存储端口。
 * 群成员个人 scope 只可在动态请求阶段读取，不应写入可复用的群会话快照。
 */
export function createImMemoryContextSource(options: {
  identity: RunIdentity
  actor: ImActor
  authorize(identity: RunIdentity, actor: ImActor): Promise<ImMemoryReadAuthorization | null>
  readText(scope: ImMemoryScopeFile, filename: string, signal?: AbortSignal): Promise<string | null>
  isTombstoned(scope: ImMemoryScopeFile): Promise<boolean>
}): Pick<ContextDataPorts, 'loadImMemory'> {
  const identity = Object.freeze({ ...options.identity }), actor = structuredClone(options.actor)
  if (!identity.ownerId || !identity.runId || !/^[1-9]\d*$/u.test(identity.sessionId)
    || actor.ownerId !== identity.ownerId || !actor.platformUserId || !actor.botId
    || !['qq', 'feishu', 'wechat', 'telegram'].includes(actor.platform)
    || !['owner', 'member', 'unknown'].includes(actor.role)
    || !['c2c', 'group'].includes(actor.chatType)
    || (actor.chatType === 'group' ? !actor.chatId : actor.chatId !== null))
    throw new ImMemorySourceError('invalid_scope')
  const base = { owner_user_id: actor.ownerId, platform: actor.platform, bot_id: actor.botId }
  const group: ImMemoryScopeFile | null = actor.chatType === 'group'
    ? { ...base, scope_type: 'group', scope_id: actor.chatId! } : null
  const member: ImMemoryScopeFile = { ...base, scope_type: 'platform-user',
    scope_id: group ? `${actor.chatId!}:${actor.platformUserId}` : actor.platformUserId }
  try {
    for (const scope of [group, member]) if (scope) imMemoryScopeFileKey(scope, 'summary.json')
  } catch { throw new ImMemorySourceError('invalid_scope') }
  const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new ImMemorySourceError('aborted') }
  async function authorize(signal?: AbortSignal): Promise<ImMemoryReadAuthorization> {
    abort(signal)
    const current = await options.authorize(identity, structuredClone(actor))
    if (!current || current.ownerId !== actor.ownerId || current.botId !== actor.botId
      || current.platform !== actor.platform || current.chatType !== actor.chatType
      || current.chatId !== actor.chatId || current.platformUserId !== actor.platformUserId
      || typeof current.groupMemoryEnabled !== 'boolean' || typeof current.memberMemoryEnabled !== 'boolean'
      || typeof current.groupOwnerMemoryEnabled !== 'boolean')
      throw new ImMemorySourceError('unauthorized')
    abort(signal)
    return current
  }
  async function read(scope: ImMemoryScopeFile, fields: readonly string[], signal?: AbortSignal): Promise<Record<string, Json> | null> {
    abort(signal)
    if (await options.isTombstoned(scope)) return null
    const result: Record<string, Json> = {}
    for (const field of fields) {
      abort(signal)
      const filename = `${field}.json`
      const text = await options.readText(scope, filename, signal)
      if (text === null) result[field] = {}
      else {
        let value: unknown
        try { value = JSON.parse(text) } catch { throw new ImMemorySourceError('invalid_data') }
        if (!value || typeof value !== 'object') throw new ImMemorySourceError('invalid_data')
        result[field] = value as Json
      }
    }
    abort(signal)
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
        if (actor.role === 'member' && before.memberMemoryEnabled) {
          const value = await read(member, ['summary', 'profile', 'pattern'], signal)
          if (value) result.platform_user = value
        }
        if (group && result.group && await options.isTombstoned(group)) delete result.group
        if (result.platform_user && await options.isTombstoned(member)) delete result.platform_user
        const after = await authorize(signal)
        if (result.group && !after.groupMemoryEnabled || result.platform_user && !after.memberMemoryEnabled)
          throw new ImMemorySourceError('unauthorized')
        abort(signal)
        return result
      } catch (error) {
        if (error instanceof ImMemorySourceError) throw error
        throw new ImMemorySourceError('unavailable')
      }
    },
  }
}
