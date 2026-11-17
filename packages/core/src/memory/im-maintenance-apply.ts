type RecordValue = Record<string, unknown>

export interface ImMaintenanceApplyInput {
  scopeType: string
  current: unknown
  output: unknown
  now: number
  date: string
}

export interface ImMaintenanceApplyResult {
  profile?: unknown[]
  pattern?: unknown[]
  summary?: { text: string; ts: number }
  daily?: string
  members?: Record<string, unknown>
}

const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown): string => value == null ? '' : String(value).trim()
const groupProfileTypes = new Set(['name', 'nature', 'rule', 'role', 'project', 'preference', 'note'])
const memberProfileTypes = new Set(['name', 'address', 'pronoun', 'background', 'preference', 'note'])
const internalId = /(?:platform_user_id|user_openid|member_openid|group_openid)\s*=/i

function normalize(value: unknown): string {
  return Array.from(String(value).trim().replace(/^-+/, '').trim().toLowerCase()).filter(char => /[\p{L}\p{N}]/u.test(char)).join('')
}

function bigrams(value: unknown): Set<string> {
  const normalized = normalize(value), chars = Array.from(normalized)
  if (chars.length < 2) return new Set(chars.length ? [normalized] : [])
  return new Set(chars.slice(0, -1).map((_, index) => chars.slice(index, index + 2).join('')))
}

function similar(left: unknown, right: unknown): boolean {
  const a = normalize(left), b = normalize(right)
  if (!a || !b) return false
  if (a === b) return true
  const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a
  if (Array.from(short).length >= 6 && long.includes(short)) return true
  const ba = bigrams(left), bb = bigrams(right), union = new Set([...ba, ...bb])
  return union.size > 0 && [...ba].filter(value => bb.has(value)).length / union.size >= 0.7
}

function profileItem(value: unknown, allowed: Set<string>, keepTimestamp: boolean): RecordValue | null {
  const item = typeof value === 'string' ? { text: value, type: 'note' } : isRecord(value) ? value : null
  if (!item) return null
  const itemText = text(item.text)
  if (!itemText) return null
  const type = text(item.type) || 'note'
  const result: RecordValue = { type: allowed.has(type) ? type : 'note', text: itemText }
  if (keepTimestamp) result.ts = item.ts
  return result
}

function mergeProfile(current: unknown, additions: unknown, removals: unknown, allowed: Set<string>, now: number, group: boolean): unknown[] {
  const result = list(current).map(item => {
    if (group && (!isRecord(item) || !allowed.has(text(item.type) || 'note'))) return null
    return profileItem(item, allowed, true)
  })
    .filter((item): item is RecordValue => item !== null && (!group || !internalId.test(String(item.text))))
  const remove = list(removals).map(item => text(isRecord(item) ? item.text : item)).filter(Boolean)
  let remaining = result.filter(item => !remove.some(target => similar(item.text, target)))
  for (const raw of list(additions)) {
    const item = profileItem(raw, allowed, false)
    const suppliedType = isRecord(raw) ? text(raw.type) || 'note' : 'note'
    if (!item || group && (!allowed.has(suppliedType) || internalId.test(String(item.text)))) continue
    const existing = remaining.find(value => similar(value.text, item.text))
    if (existing) {
      existing.ts = now
      existing.type = item.type
      if (Array.from(String(item.text)).length > Array.from(String(existing.text)).length) existing.text = item.text
    } else remaining.push({ ...item, ts: now })
  }
  return remaining
}

function mergePattern(current: unknown, incoming: unknown): unknown[] {
  const seen = new Set<string>(), result: unknown[] = []
  for (const raw of [...list(current), ...list(incoming)]) {
    if (!isRecord(raw)) continue
    const itemText = text(raw.text)
    if (!itemText || seen.has(itemText)) continue
    seen.add(itemText)
    const importance = Number(raw.importance || 1)
    result.push({ text: itemText, kind: text(raw.kind) || 'observed', importance: Number.isFinite(importance) ? Math.trunc(importance) : 1 })
  }
  return result
}

function dailyEntries(value: unknown): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  let date = ''
  for (const line of text(value).split(/\r?\n/).map(item => item.trim())) {
    if (line.startsWith('## ') && line.length >= 12) date = line.slice(3).trim()
    else if (date && line.startsWith('- ') && line.slice(2).trim()) entries.push([date, line.slice(2).trim()])
  }
  return entries
}

function renderDaily(entries: Array<[string, string]>): string {
  let previous = ''
  const lines: string[] = []
  for (const [date, note] of entries) {
    if (date !== previous) {
      if (lines.length) lines.push('')
      lines.push(`## ${date}`)
      previous = date
    }
    lines.push(`- ${note}`)
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/** 纯 IM 记忆合并规则；Host 负责读写 Local 文件与 source revision 事务。 */
export function applyImMaintenanceOutput(input: ImMaintenanceApplyInput): ImMaintenanceApplyResult {
  if (!Number.isFinite(input.now) || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new TypeError('记忆维护时间无效')
  const current = isRecord(input.current) ? input.current : {}, output = isRecord(input.output) ? input.output : {}
  const group = input.scopeType === 'group'
  if (!group && input.scopeType !== 'platform-user') throw new TypeError('记忆作用域类型无效')
  const result: ImMaintenanceApplyResult = {}
  if (group) {
    const profile = mergeProfile(current.profile, output.profile_add, output.profile_remove, groupProfileTypes, input.now, true)
    if (profile.length || list(output.profile_add).length || list(output.profile_remove).length) result.profile = profile
    const membersDocument = isRecord(current.members) ? structuredClone(current.members) : {}
    const members = isRecord(membersDocument.members) ? membersDocument.members : {}
    const nicknameAdditions = list(output.nicknames_add)
    if (nicknameAdditions.length && Object.keys(members).length) {
      for (const raw of nicknameAdditions) {
        if (!isRecord(raw)) continue
        const id = text(raw.platform_user_id), nickname = text(raw.nickname), member = members[id]
        if (!id || !nickname || !isRecord(member)) continue
        const nicknames = list(member.nicknames).map(String)
        if (!nicknames.includes(nickname)) member.nicknames = [...nicknames, nickname]
      }
      result.members = { updated_at: input.now, members }
    }
  } else {
    const profile = mergeProfile(current.profile, output.profile, [], memberProfileTypes, input.now, false)
    if (profile.length) result.profile = profile
    const pattern = mergePattern(current.pattern, output.pattern)
    if (pattern.length) result.pattern = pattern
  }
  const summary = text(output.summary)
  if (summary) result.summary = { text: summary, ts: input.now }
  const entries = dailyEntries(current.daily)
  if (group) {
    for (const item of list(typeof output.daily === 'string' ? [output.daily] : output.daily).filter(value => typeof value === 'string')) {
      const note = text(item)
      if (note) entries.unshift([input.date, note])
    }
    result.daily = renderDaily(entries)
  } else {
    const note = text(output.daily)
    if (note) entries.unshift([input.date, note])
    result.daily = renderDaily(entries.slice(0, 50))
  }
  return result
}

function pythonTruthy(value: unknown): boolean {
  if (value == null || value === false || value === 0 || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return true
}

/** Python 预览 Worker 的跨批增量合并；后续批次不得清空先前有效字段。 */
export function mergeImMaintenanceOutputs(outputs: readonly unknown[]): RecordValue {
  const merged: RecordValue = {}, members = new Map<string, RecordValue>()
  for (const raw of outputs) {
    if (!isRecord(raw)) continue
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'members' && Array.isArray(value)) {
        for (const item of value) {
          if (!isRecord(item) || !pythonTruthy(item.platform_user_id)) continue
          const memberId = String(item.platform_user_id)
          const target = members.get(memberId) ?? { platform_user_id: memberId }
          for (const [field, fieldValue] of Object.entries(item)) {
            if (field === 'platform_user_id') continue
            if (Array.isArray(fieldValue)) {
              const current = target[field]
              const listValue = Array.isArray(current) ? current : []
              if (!Array.isArray(current)) target[field] = listValue
              listValue.push(...fieldValue)
            } else if (pythonTruthy(fieldValue)) target[field] = fieldValue
          }
          members.set(memberId, target)
        }
      } else if (Array.isArray(value)) {
        const current = merged[key]
        if (!Array.isArray(current)) merged[key] = []
        ;(merged[key] as unknown[]).push(...value)
      } else if (pythonTruthy(value)) merged[key] = value
    }
  }
  if (members.size) merged.members = [...members.values()]
  return merged
}
