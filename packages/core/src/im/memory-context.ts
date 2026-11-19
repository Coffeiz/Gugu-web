import type { Json } from '../agent/models.js'
import { agentContextPolicy } from '../agent/context/source-policy.js'
import type { ImActor } from './access.js'

const budget = 3000
const entryLimit = 50
type MemoryRecord = Readonly<Record<string, unknown>>
const record = (value: unknown): value is MemoryRecord => value !== null && typeof value === 'object' && !Array.isArray(value)
function invalid(): never { throw new TypeError('IM 记忆形状无效') }
function scope(data: unknown, key: 'group' | 'platform_user'): MemoryRecord {
  if (data === null || data === undefined) return {}
  if (!record(data)) return invalid()
  const value = data[key]
  if (value === null || value === undefined) return {}
  return record(value) ? value : invalid()
}
function scalar(value: unknown): string {
  if (value === null) return 'None'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return invalid()
}
function chosenText(value: MemoryRecord): string {
  const selected = value.text || value.content || ''
  return scalar(selected).trim()
}
/** 不把任意对象强转成repr；仅支持Python记忆格式中的文本/JSON标量和列表。 */
function memoryValueText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    const rows: string[] = []
    for (const item of value.slice(0, entryLimit)) {
      if (Array.isArray(item)) return invalid()
      const text = record(item) ? chosenText(item) : scalar(item).trim()
      if (text) rows.push(record(item) ? `- ${text}` : `- ${scalar(item).trim()}`)
    }
    return rows.join('\n')
  }
  if (record(value)) return chosenText(value)
  return value ? scalar(value).trim() : ''
}
function boundedParts(parts: readonly (readonly [string, unknown])[]): string[] {
  let used = 0
  const result: string[] = []
  for (const [title, value] of parts) {
    const content = memoryValueText(value)
    if (!content || used >= budget) continue
    const selected = Array.from(content).slice(0, budget - used).join('').trimEnd()
    if (selected) { result.push(`### ${title}\n${selected}`); used += Array.from(selected).length }
  }
  return result
}

/** 群公开summary/profile；不读取长期memory或成员个人字段。 */
export function formatGroupMemory(data: unknown): string {
  const group = scope(data, 'group')
  const parts = boundedParts([['群组 summary', group.summary], ['群组 profile', group.profile]])
  return parts.length ? '## 当前群组记忆（仅限本群公开信息）\n\n' + parts.join('\n\n') : ''
}
/** 调用者必须已验证当前发言人scope；该函数不负责跨用户数据读取。 */
export function formatPlatformUserMemory(data: unknown): string {
  const personal = scope(data, 'platform_user')
  const parts = boundedParts([
    ['当前发言人的平台记忆 summary', personal.summary],
    ['当前发言人的平台记忆 profile', personal.profile],
    ['当前发言人的平台记忆 pattern', personal.pattern],
  ])
  return parts.length ? '## 当前发言人的平台记忆（仅用于理解当前发言人，不是当前请求）\n\n' + parts.join('\n\n') : ''
}

/** snapshot只存可展示字段，不复制scope里的长期memory、owner或其他元数据。 */
function snapshotScope(source: MemoryRecord, keys: readonly string[]): Record<string, Json> {
  const result: Record<string, Json> = {}
  for (const key of keys) {
    const value = source[key]
    if (value === undefined) continue
    if (Array.isArray(value)) {
      result[key] = value.slice(0, entryLimit).map(item => {
        if (Array.isArray(item)) return invalid()
        if (record(item)) return { text: chosenText(item) }
        scalar(item)
        return item as Json
      })
    } else if (record(value)) result[key] = { text: chosenText(value) }
    else { if (value !== null) scalar(value); result[key] = value as Json }
  }
  return result
}

/**
 * memoryEnabled由可信Host显式提供，其含义沿共享策略：owner记忆总开关不替代IM scope授权。
 * 群snapshot永远不包含platform_user；私聊仅受限actor保存其已授权个人scope。
 */
export function snapshotImMemory(snapshotContext: string, imMemory: unknown, actor: ImActor, memoryEnabled: boolean): {
  snapshotContext: string
  imMemory: Record<string, Json>
} {
  if (typeof snapshotContext !== 'string' || typeof memoryEnabled !== 'boolean') return invalid()
  const policy = agentContextPolicy({ source: actor.platform, actorContext: actor, memoryEnabled })
  const group = actor.chatType === 'group' ? snapshotScope(scope(imMemory, 'group'), ['summary', 'profile']) : {}
  const personal = actor.chatType !== 'group' && policy.restricted ? snapshotScope(scope(imMemory, 'platform_user'), ['summary', 'profile', 'pattern']) : {}
  const groupBlock = formatGroupMemory({ group })
  if (groupBlock) snapshotContext += '\n\n---\n\n' + groupBlock
  const personalBlock = formatPlatformUserMemory({ platform_user: personal })
  if (personalBlock) snapshotContext += '\n\n---\n\n' + personalBlock
  return { snapshotContext, imMemory: actor.chatType === 'group' ? { group } : { platform_user: personal } }
}
