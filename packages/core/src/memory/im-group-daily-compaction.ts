import { createHash } from 'node:crypto'

export const GROUP_DAILY_COMPACTION_TRIGGER = 100
export const GROUP_DAILY_COMPACTION_BATCH_SIZE = 100
export const GROUP_DAILY_HARD_CAP = 300

export function shouldCompactGroupDaily(count: number, trigger = GROUP_DAILY_COMPACTION_TRIGGER): boolean {
  return count >= trigger
}

export function parseGroupDailyEntries(value: string): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  let date = ''
  for (const raw of value.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.startsWith('## ') && line.length >= 12) date = line.slice(3).trim()
    else if (date && line.startsWith('- ') && line.slice(2).trim()) entries.push([date, line.slice(2).trim()])
  }
  return entries
}

export function renderGroupDailyEntries(entries: readonly (readonly [string, string])[]): string {
  const lines: string[] = []
  let date = ''
  for (const [entryDate, note] of entries) {
    if (entryDate !== date) {
      if (lines.length) lines.push('')
      lines.push(`## ${entryDate}`)
      date = entryDate
    }
    lines.push(`- ${note}`)
  }
  return lines.length ? `${lines.join('\n').trim()}\n` : ''
}

/** 输入按新到旧排列；返回仍待处理的较新条目和当前最旧批次。 */
export function splitOldestGroupDailyBatch<T>(entries: readonly T[], batchSize = GROUP_DAILY_COMPACTION_BATCH_SIZE): [T[], T[]] {
  const items = [...entries], size = Math.max(1, batchSize)
  return items.length <= size ? [[], items] : [items.slice(0, -size), items.slice(-size)]
}

const datePattern = /20\d{2}-\d{1,2}-\d{1,2}/gu
export function groupDailyDatesPreserved(entries: readonly (readonly [string, string])[], memory: string): boolean {
  const dates = new Set((entries.map(([date]) => date).join('\n').match(datePattern) ?? []))
  return dates.size === 0 || [...dates].every(date => new RegExp(date.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u').test(memory))
}

const heading = /^##(?!#)\s*(.+?)\s*$/u
const eventPrefix = '记录长期记忆：'
interface EventSection { title: string; body: string }

function normalizeTitle(raw: unknown, fallback = '未命名事件'): string {
  const value = String(raw ?? '').replace(/\s+/gu, ' ').trim()
    .replace(/^记录长期记忆：/u, '').trim().replace(/^[：:·\- ]+/u, '').trim()
  return value || fallback
}

export function normalizeGroupEventMemory(raw: unknown, fallbackTitle = ''): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  let found = false
  const normalized = text.split(/\r?\n/u).map(line => {
    const match = heading.exec(line.trim())
    if (!match) return line.replace(/\s+$/u, '')
    found = true
    return `## ${eventPrefix}${normalizeTitle(match[1])}`
  }).join('\n').trim()
  if (found) return normalized
  const date = /20\d{2}-\d{1,2}-\d{1,2}/u.exec(text)?.[0]
  const title = normalizeTitle(fallbackTitle || date || '事件记录')
  return `## ${eventPrefix}${title}\n\n${text}`
}

function parseSections(text: string): EventSection[] {
  const normalized = normalizeGroupEventMemory(text)
  const sections: EventSection[] = []
  let title: string | null = null, body: string[] = []
  const flush = () => {
    const content = body.join('\n').trim()
    if (title !== null && content) sections.push({ title, body: content })
  }
  for (const line of normalized.split('\n')) {
    const match = heading.exec(line.trim())
    if (match) {
      flush()
      title = normalizeTitle(match[1])
      body = []
    } else if (title !== null) body.push(line)
  }
  flush()
  return sections
}

function eventHash(section: EventSection): string {
  const payload = `${normalizeTitle(section.title)}\n${section.body.trim()}`
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** 复刻 Python normalize_event_memory + deduplicate_event_sections 的确定性整理。 */
export function deduplicateGroupEventMemory(text: unknown): string {
  const sections = parseSections(String(text ?? ''))
  if (!sections.length) return normalizeGroupEventMemory(text)
  const merged: EventSection[] = [], byTitle = new Map<string, number>(), seenHashes = new Set<string>()
  for (const section of sections) {
    const hash = eventHash(section)
    if (seenHashes.has(hash)) continue
    seenHashes.add(hash)
    const title = normalizeTitle(section.title), index = byTitle.get(title)
    if (index === undefined) {
      byTitle.set(title, merged.length)
      merged.push(section)
      continue
    }
    const previous = merged[index]!, previousLines = new Set(previous.body.split('\n').map(line => line.trim()).filter(Boolean))
    const additions = section.body.split('\n').filter(line => line.trim() && !previousLines.has(line.trim()))
    if (additions.length) merged[index] = { title: previous.title, body: `${previous.body.replace(/\s+$/u, '')}\n${additions.join('\n')}` }
  }
  return merged.map(section => `## ${eventPrefix}${normalizeTitle(section.title)}\n\n${section.body.trim()}`).join('\n\n').trim()
}
