import { strip } from '../../shared/values.js'

export const PROFILE_TYPES = ['name', 'address', 'pronoun', 'background', 'preference', 'note'] as const
export type ProfileType = typeof PROFILE_TYPES[number]
export type MemoryTarget = 'profile' | 'pattern'
export type MemoryRow = { text: string; [field: string]: unknown }
export interface RememberInput {
  target: MemoryTarget
  text: string
  remove: readonly string[]
  type?: ProfileType
  importance?: number
}

function normalizedText(value: string): string {
  return strip(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function bigrams(chars: readonly string[]) {
  if (chars.length <= 1) return new Set(chars)
  return new Set(chars.slice(1).map((char, index) => chars[index]! + char))
}

/** Python pattern/profile 共用的保守匹配：归一相等、至少六字符的子串或 bigram Jaccard。 */
export function similarRememberText(left: string, right: string): boolean {
  const a = normalizedText(left), b = normalizedText(right)
  if (!a || !b) return false
  if (a === b) return true
  const as = Array.from(a), bs = Array.from(b)
  const [short, long, size] = as.length <= bs.length ? [a, b, as.length] : [b, a, bs.length]
  if (size >= 6 && long.includes(short)) return true
  const aa = bigrams(as), bb = bigrams(bs)
  let overlap = 0
  for (const item of aa) if (bb.has(item)) overlap++
  return overlap / (aa.size + bb.size - overlap) >= 0.7
}

/** /forget 沿用旧命令的单向子串匹配，最少需要两个有效字符。 */
export function forgetMemoryEdit(before: readonly MemoryRow[], target: MemoryTarget, query: string) {
  const needle = normalizedText(query)
  const rows = Array.from(needle).length < 2 ? [...before]
    : before.filter(row => !normalizedText(row.text).includes(needle) && !similarRememberText(row.text, query))
  return { rows, value: { success: true, target, added: 0, removed: before.length - rows.length } }
}

export function applyRememberEdit(before: readonly MemoryRow[], input: RememberInput, now: number, patternId: () => string,
  patternKind: 'observed' | 'inferred' = 'observed') {
  const after = before.filter(row => !input.remove.some(text => similarRememberText(row.text, text))).map(row => ({ ...row }))
  const text = input.text
  if (text) {
    const match = after.find(row => similarRememberText(row.text, text))
    if (input.target === 'profile') {
      const type = input.type ?? 'note'
      if (match) Object.assign(match, { type, ts: now })
      else after.push({ type, text, ts: now })
    } else {
      const importance = input.importance ?? 3
      if (match) {
        const confidence = typeof match.conf === 'number' && Number.isFinite(match.conf) && match.conf ? match.conf : 0.6
        Object.assign(match, { kind: match.kind === 'observed' ? 'observed' : patternKind, conf: Math.min(0.97, confidence + 0.1), imp: importance, ts: now })
      } else after.push({ id: patternId(), text, kind: patternKind, conf: patternKind === 'observed' ? 0.9 : 0.6, imp: importance, ts: now })
    }
    if (match && Array.from(text).length > Array.from(match.text).length) match.text = text
  }
  const added = after.filter(row => !before.some(old => similarRememberText(row.text, old.text))).length
  const removed = before.filter(row => !after.some(next => similarRememberText(row.text, next.text))).length
  return { rows: after, value: { success: true, target: input.target, added, removed, ...(text ? { remembered: text } : {}) } }
}
