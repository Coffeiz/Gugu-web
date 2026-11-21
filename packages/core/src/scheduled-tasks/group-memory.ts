import type { Kysely } from 'kysely'
import { groupScopePrefix, type MemoryRagStorageReader } from '../agent/rag/memory-loader.js'
import { createImMaintenanceSource } from '../memory/im-maintenance-source.js'
import type { ScheduledTaskExecutionPlan } from './run-now-read.js'

const characterBudget = 3_000
const entryLimit = 50
const fileLimit = 2_000_000

function recordText(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ''
  const { text, content } = value as Record<string, unknown>
  return scalarText(text || content || '')
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return value === null ? 'None' : ''
}

function memoryText(raw: string | null): string {
  if (!raw?.trim()) return ''
  let value: unknown
  try { value = JSON.parse(raw) } catch { return '' }
  if (!Array.isArray(value)) return recordText(value)
  return value.slice(0, entryLimit).flatMap(item => {
    const text = item !== null && typeof item === 'object' ? recordText(item) : scalarText(item)
    return text ? [`- ${text}`] : []
  }).join('\n')
}

/** 只读取已授权群的公开概要和资料，删除标记优先于残留文件。 */
export function createScheduledTaskGroupMemoryReader<DB>(db: Kysely<DB>, storage: MemoryRagStorageReader,
  isTombstoned = createImMaintenanceSource(db).isTombstoned) {
  return async (scope: NonNullable<ScheduledTaskExecutionPlan['groupScope']>): Promise<string> => {
    const { ownerId, platform, botId, scopeId } = scope
    const key = { owner_user_id: ownerId, platform, bot_id: botId, scope_type: 'group' as const, scope_id: scopeId }
    if (await isTombstoned(key)) return ''
    const prefix = groupScopePrefix(ownerId, { ownerId, platform, botId, type: 'group', id: scopeId })
    const files = ['summary', 'profile'] as const
    const records = await Promise.all(files.map(name =>
      storage.readText({ ownerId, key: `${prefix}${name}.json`, maxChars: fileLimit })))
    if (await isTombstoned(key)) return ''
    let remaining = characterBudget
    const sections: string[] = []
    for (const [index, raw] of records.entries()) {
      const text = Array.from(memoryText(raw)).slice(0, remaining).join('').trimEnd()
      if (!text) continue
      sections.push(`### 群组 ${files[index]}\n${text}`)
      remaining -= Array.from(text).length
      if (remaining === 0) break
    }
    return sections.length ? `## 当前群组记忆（仅限本群公开信息）\n\n${sections.join('\n\n')}` : ''
  }
}
