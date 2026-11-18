import { z } from 'zod'
import { applyRememberEdit, PROFILE_TYPES, type MemoryRow } from './remember.js'

const note = z.string().trim().min(1)
const edits = z.object({
  profile_add: z.array(z.object({ type: z.enum(PROFILE_TYPES), text: note })).default([]),
  profile_remove: z.array(note).default([]),
  pattern_add: z.array(z.object({ text: note, kind: z.enum(['observed', 'inferred']), importance: z.number().int().min(1).max(5) })).default([]),
  pattern_remove: z.array(note).default([]),
  summary: z.string().trim().default(''),
  daily: z.string().trim().default(''),
  perception: z.object({ intent: z.enum(['执行', '推进', '记录', '查询', '决策', '反思', '情绪', '陪伴', '闲聊']) }).optional(),
})

export const ownerReflectionFiles = ['pattern_vec.json', 'profile.json', 'pattern.json', 'summary.json', 'daily.md', 'stance.json'] as const
export type OwnerReflectionFile = typeof ownerReflectionFiles[number]
export type OwnerReflectionFiles = Record<OwnerReflectionFile, string | null>

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('反思记忆档案格式无效')
  return value as Record<string, unknown>
}

function list(raw: string | null, target: 'profile' | 'pattern'): MemoryRow[] {
  if (!raw?.trim()) return []
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value)) throw new Error('反思记忆档案格式无效')
  return value.map(item => {
    if (target === 'profile' && typeof item === 'string' && item.trim()) return { text: item.trim(), type: 'note', ts: null }
    const row = record(item)
    if (typeof row.text !== 'string' || !row.text.trim()) throw new Error('反思记忆条目无效')
    return { ...row, text: row.text.trim() }
  })
}

/** 反思增量只计算新档案，路径、授权与发布由 Host 固定。 */
export function planOwnerReflectionEdits(current: OwnerReflectionFiles, output: unknown, now: number, date: string, patternId: () => string): Partial<Record<OwnerReflectionFile, string>> {
  if (!Number.isFinite(now) || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('反思时间无效')
  const edit = edits.parse(output)
  const result: Partial<Record<OwnerReflectionFile, string>> = {}
  const store = (name: OwnerReflectionFile, data: unknown) => { result[name] = JSON.stringify(data, null, 2) }
  if (edit.profile_add.length || edit.profile_remove.length) {
    const before = list(current['profile.json'], 'profile')
    let rows = before.filter(row => !edit.profile_remove.includes(row.text))
    for (const add of edit.profile_add)
      rows = applyRememberEdit(rows, { target: 'profile', ...add, remove: [] }, now, patternId).rows
    if (JSON.stringify(rows) !== JSON.stringify(before)) store('profile.json', rows)
  }
  if (edit.pattern_add.length || edit.pattern_remove.length) {
    const before = list(current['pattern.json'], 'pattern')
    let rows = before.filter(row => !edit.pattern_remove.includes(row.text))
    for (const { text, kind, importance } of edit.pattern_add)
      rows = applyRememberEdit(rows, { target: 'pattern', text, importance, remove: [] }, now, patternId, kind).rows
    if (JSON.stringify(rows) !== JSON.stringify(before)) {
      store('pattern.json', rows)
      const oldText = new Map(before.map(row => [row.id, row.text]))
      const stableIds = new Set(rows.filter(row => oldText.get(row.id) === row.text).map(row => row.id))
      if (current['pattern_vec.json']?.trim()) {
        const vectors = record(JSON.parse(current['pattern_vec.json']))
        const retained = Object.entries(vectors).filter(([id]) => stableIds.has(id))
        if (retained.length !== Object.keys(vectors).length) store('pattern_vec.json', Object.fromEntries(retained))
      }
    }
  }
  if (edit.summary) {
    const previous = current['summary.json']?.trim() ? record(JSON.parse(current['summary.json'])) : {}
    if (edit.summary !== previous.text) store('summary.json', { text: edit.summary, ts: now })
  }
  if (edit.perception) store('stance.json', { stance: edit.perception.intent, ts: now })
  if (edit.daily) {
    const previous = current['daily.md'] ?? ''
    const heading = `## ${date}\n`, line = `- ${edit.daily.replace(/\s*\r?\n\s*/gu, ' ')}\n`
    result['daily.md'] = previous.startsWith(heading) ? heading + line + previous.slice(heading.length)
      : heading + line + (previous.trim() ? '\n' + previous : '')
  }
  return result
}
