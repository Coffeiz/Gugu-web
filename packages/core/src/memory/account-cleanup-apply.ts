import { applyRememberEdit, type MemoryRow } from '../agent/memory/remember.js'
import { CoreError } from '../contracts/index.js'
import { strip } from '../shared/values.js'
import type { AccountMemoryCleanupPlan } from './account-cleanup-preview.js'

type StoredPattern = MemoryRow & { id: string }

interface AccountMemoryCleanupSource {
  revision: string
  patterns: readonly StoredPattern[]
  profile: readonly MemoryRow[]
  memory: string
}
interface AccountMemoryCleanupChanges {
  patterns?: readonly StoredPattern[]
  profile?: readonly MemoryRow[]
  memory?: string
  daily?: string
}

function groupApprovedDaily(entries: readonly string[]): string {
  const lines: string[] = []
  let day: string | undefined
  for (const entry of entries) {
    const separator = entry.indexOf(' ')
    const current = entry.slice(0, separator)
    if (!/^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u.test(current) || separator === entry.length - 1)
      throw new CoreError('invalid_request', '记忆维护预览的日报条目无效')
    if (current !== day) {
      if (day) lines.push('')
      lines.push(`## ${current}`)
      day = current
    }
    lines.push(`- ${entry.slice(separator + 1)}`)
  }
  return lines.length ? lines.join('\n') + '\n' : ''
}

/** 按已确认计划计算改写，供持有 owner 写锁的事务适配器提交。 */
export function prepareAccountMemoryCleanupChanges(
  source: AccountMemoryCleanupSource, plan: AccountMemoryCleanupPlan, now: number,
): AccountMemoryCleanupChanges {
  if (!plan.source_revision || source.revision !== plan.source_revision)
    throw new CoreError('conflict', '记忆维护预览已过期，源数据发生变化，请重新生成预览')

  const changes: AccountMemoryCleanupChanges = {}
  const dropPatterns = new Set([...plan.removed_ids, ...plan.moved_ids])
  const remaining = source.patterns.filter(item => !dropPatterns.has(item.id))
  if (remaining.length !== source.patterns.length) changes.patterns = remaining

  // 确认后的搬迁沿用现场画像的模糊合并规则，但只搬迁预览中列出的事件。
  const approvedEvents = new Set(plan.profile_event_texts)
  let profile = source.profile.filter(item => !approvedEvents.has(strip(item.text)))
  const moved = source.profile.filter(item => approvedEvents.has(strip(item.text)))
  for (const text of plan.moved_texts) {
    profile = applyRememberEdit(profile, { target: 'profile', text: strip(text), remove: [] }, now,
      () => { throw new Error('画像条目不生成模式 ID') }).rows
  }
  if (plan.moved_texts.length || moved.length) changes.profile = profile

  const append = moved.map(item => strip(item.text)).filter(text => !source.memory.includes(text))
  if (append.length) {
    const block = ['## 画像迁移补记', ...append.map(text => `- ${text}`)].join('\n')
    changes.memory = [strip(source.memory), block].filter(Boolean).join('\n\n')
  }
  if (plan.daily_texts.length) changes.daily = groupApprovedDaily(plan.daily_texts)
  return changes
}
