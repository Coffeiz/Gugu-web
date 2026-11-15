import { CoreError, dataContext } from '../../contracts/index.js'

/** 可信存储返回 null 表示确实不存在；读取错误必须抛出。 */
export interface AgentMemoryReadStore { read(key: string): Promise<Uint8Array | null> }
export interface AgentSmallMemory {
  profile: string; pattern: string; memory: string; daily: string; summary: string
  summary_ts: number | null; first_ts: number | null; stance: string | null; stance_ts: number | null; lens: string
}
type RecordValue = Record<string, unknown>
const unavailable = () => new CoreError('storage_error', '记忆数据暂不可用')
const object = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown) => { if (typeof v !== 'string') throw unavailable(); return v.trim() }
const numeric = (v: unknown): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw unavailable(); return v }
const optionalNumber = (v: unknown) => v == null ? null : numeric(v)
const chars = (v: string) => Array.from(v).length
const prefix = (v: string, length: number) => Array.from(v).slice(0, length).join('')
function weight(ts: number | null, now: number, half: number): number {
  return ts ? 0.5 ** (Math.max(0, (now - ts) / 86400) / half) : 1
}
function parse(raw: string | null): unknown {
  if (raw === null || !raw.trim()) return null
  try { return JSON.parse(raw) } catch { throw unavailable() }
}

/** 只处理规范文件与无 embedding 触发的数据；其余情况必须由真实服务处理。 */
export function createSmallAgentMemory(store: AgentMemoryReadStore, nowSeconds: () => number) {
  if (!store || typeof store.read !== 'function' || typeof nowSeconds !== 'function') throw new TypeError('记忆读取端口未完整配置')
  return async (ownerId: string, signal?: AbortSignal): Promise<AgentSmallMemory> => {
    signal?.throwIfAborted()
    const owner = dataContext(ownerId).ownerId, base = `${owner}/.agent/`, now = numeric(nowSeconds())
    const names = ['profile.json','pattern.json','facts.json','facts.md','memory.md','daily.md','summary.json','summary.md','summary.ts','stance.json','lens.json'] as const
    let values: Array<Uint8Array | null>
    try { values = await Promise.all(names.map(name => store.read(base + name))) } catch { signal?.throwIfAborted(); throw unavailable() }
    signal?.throwIfAborted()
    if (values.some(value => value !== null && !(value instanceof Uint8Array))) throw unavailable()
    const files = Object.fromEntries(names.map((name, i) => [name, values[i] === null ? null : new TextDecoder().decode(values[i]!) ])) as Record<typeof names[number], string | null>
    const patternRaw = files['pattern.json']
    if ((patternRaw === null && (files['facts.json']?.trim() || files['facts.md']?.trim())) || patternRaw !== null && !patternRaw.trim()) throw unavailable()
    const patternData = parse(patternRaw) ?? []
    if (!Array.isArray(patternData)) throw unavailable()
    const patterns = patternData.map(value => {
      if (!object(value) || typeof value.text !== 'string' || !['observed','inferred'].includes(String(value.kind))) throw unavailable()
      const conf = value.conf ? numeric(value.conf) : 0.6, imp = value.imp ? numeric(value.imp) : 3
      const ts = optionalNumber(value.ts), body = text(value.text)
      return { body, conf, imp, ts, kind: value.kind }
    }).filter(value => value.body)
    const memory = (files['memory.md'] ?? '').trim()
    if (patterns.length > 50 || chars(memory) > 3000) throw unavailable()
    const profileData = parse(files['profile.json']) ?? []
    if (!Array.isArray(profileData)) throw unavailable()
    const profile = profileData.map(value => { if (!object(value) || typeof value.text !== 'string') throw unavailable(); return text(value.text) }).filter(Boolean).slice(0, 50).map(value => `- ${value}`).join('\n')
    const scored = patterns.map(value => ({ ...value, effective: value.conf * (value.kind === 'inferred' ? weight(value.ts, now, 45) : 1) }))
      .filter(value => value.effective >= 0.2).sort((a, b) => b.effective * b.imp - a.effective * a.imp)
    const pattern = scored.map(value => `- ${value.body}${value.kind === 'inferred' && value.effective < 0.45 ? '（不太确定）' : ''}`).join('\n')
    const timestamps = patterns.map(value => value.ts).filter((value): value is number => !!value)
    const summaryData = parse(files['summary.json'])
    if (summaryData === null && (files['summary.md']?.trim() || files['summary.ts']?.trim())) throw unavailable()
    if (summaryData !== null && !object(summaryData)) throw unavailable()
    const summary = summaryData ? text(summaryData.text ?? '') : '', summaryTs = summaryData ? optionalNumber(summaryData.ts) : null
    const stanceData = parse(files['stance.json'])
    if (stanceData !== null && !object(stanceData)) throw unavailable()
    const stance = stanceData ? text(stanceData.stance ?? '') || null : null, stanceTs = stanceData ? optionalNumber(stanceData.ts) : null
    const lensData = parse(files['lens.json'])
    if (lensData !== null && !object(lensData)) throw unavailable()
    const rules = lensData?.rules ?? []
    if (!Array.isArray(rules)) throw unavailable()
    const lensLines = rules.map(value => {
      if (!object(value)) throw unavailable()
      return { body: text(value.rule ?? ''), effective: (value.confidence ? numeric(value.confidence) : 0) * weight(optionalNumber(value.last_seen), now, 30) }
    }).sort((a,b) => b.effective - a.effective).filter(rule => rule.effective >= 0.25 && rule.body).slice(0,12)
      .map(rule => `- ${rule.effective >= 0.6 ? '' : rule.effective >= 0.4 ? '（多半）' : '（也许，留意但别笃定）'}${rule.body}`)
    const lens = lensLines.length ? '## 怎么读懂 TA（解读镜片 · 偏置不独裁）\n下面是相处里摸出的、读懂这个人的经验先验。用它**偏置**你的理解，但别当铁律——和当下语境冲突时以当下为准。\n' + lensLines.join('\n') : ''
    return { profile, pattern, memory, daily: prefix((files['daily.md'] ?? '').trim(), 2000), summary, summary_ts: summaryTs,
      first_ts: timestamps.length ? Math.min(...timestamps) : null, stance, stance_ts: stanceTs, lens }
  }
}
