import { splitUserMemoryVectorChunks, userMemoryVectorChunkKey } from '../../byok/vector-rebuild.js'
import type { Json } from '../models.js'

export interface AgentMemoryContextStorage {
  readText(input: { ownerId: string; key: string; maxChars: number; signal?: AbortSignal }): Promise<string | null>
}

export interface AgentMemoryContextInput {
  ownerId: string
  query: string
  now: number
  storage: AgentMemoryContextStorage
  vectorSearch?: AgentMemoryVectorSearchPort
  signal?: AbortSignal
}

export interface AgentMemoryVectorSearchPort {
  embed(ownerId: string, query: string, signal?: AbortSignal): Promise<{ vector: readonly number[]; modelTag: string } | null>
  read(ownerId: string, kind: 'pattern' | 'memory', signal?: AbortSignal): Promise<unknown>
}

export interface AgentMemoryContext extends Record<string, Json> {
  profile: string
  pattern: string
  memory: string
  daily: string
  summary: string
  summary_ts: number | null
  first_ts: number | null
  stance: string | null
  stance_ts: number | null
  lens: string
}

const OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const FILE_LIMIT = 20_000_000
const PROFILE_INJECT_MAX = 50
const PATTERN_INJECT_MAX = 50
const PATTERN_FLOOR_K = 6
const PATTERN_RETIRE_EFF = 0.2
const PATTERN_INFERRED_HALF_LIFE_DAYS = 45
const MEMORY_INJECT_CHARS = 3_000
const DAILY_INJECT_CHARS = 2_000
const LENS_HALF_LIFE_DAYS = 30
const LENS_RETIRE_EFF = 0.25
const LENS_MAX_RULES = 12

type ObjectValue = Record<string, unknown>
type Pattern = { id?: string; text: string; kind: string; conf: number; imp: number; ts: number | null }
type MemoryVector = { v: number[]; t: string }

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parse(raw: string | null): unknown {
  if (!raw?.trim()) return null
  try { return JSON.parse(raw) as unknown } catch { return null }
}

async function read(storage: AgentMemoryContextStorage, ownerId: string, name: string, maxChars = FILE_LIMIT, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
  try {
    const value = await storage.readText({ ownerId, key: `${ownerId}/.agent/memories/${name}`, maxChars, ...(signal ? { signal } : {}) })
    signal?.throwIfAborted()
    return value
  } catch (error) {
    signal?.throwIfAborted()
    return null
  }
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function profileText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap(item => {
    const text = typeof item === 'string' ? item.trim() : object(item) ? String(item.text ?? '').trim() : ''
    return text ? [text] : []
  }).slice(0, PROFILE_INJECT_MAX).map(text => `- ${text}`).join('\n')
}

export async function readAgentMemoryProfile(storage: AgentMemoryContextStorage, ownerId: string, signal?: AbortSignal) {
  return profileText(parse(await read(storage, ownerId, 'profile.json', 1_000_000, signal)))
}

export async function readAgentMemoryDaily(storage: AgentMemoryContextStorage, ownerId: string, signal?: AbortSignal) {
  return ((await read(storage, ownerId, 'daily.md', 500_000, signal)) ?? '').trim().slice(0, DAILY_INJECT_CHARS)
}

function readPatterns(patternRaw: string | null, factsRaw: string | null, factsMarkdown: string | null): Pattern[] {
  if (patternRaw !== null) {
    if (!patternRaw.trim()) return []
    const value = parse(patternRaw)
    if (!Array.isArray(value)) return []
    return value.flatMap(item => {
      if (!object(item)) return []
      const text = String(item.text ?? '').trim()
      if (!text) return []
      const conf = finite(item.conf)
      const imp = finite(item.imp)
      return [{ id: typeof item.id === 'string' ? item.id : undefined, text,
        kind: item.kind === 'inferred' ? 'inferred' : 'observed', conf: conf ?? 0.6,
        imp: imp || 3, ts: finite(item.ts) }]
    })
  }
  if (factsRaw?.trim()) {
    const legacy = parse(factsRaw)
    if (Array.isArray(legacy)) {
      const rows = legacy.flatMap(item => object(item) && String(item.text ?? '').trim()
        ? [{ text: String(item.text).trim(), kind: 'observed', conf: 0.75, imp: 3, ts: finite(item.ts) }] : [])
      if (rows.length) return rows
    }
  }
  return (factsMarkdown ?? '').split(/\r?\n/u).map(line => line.trim().replace(/^-\s*/u, '')).filter(Boolean)
    .map(text => ({ text, kind: 'observed', conf: 0.75, imp: 3, ts: null }))
}

function patternEffective(pattern: Pattern, now: number): number {
  const confidence = pattern.conf || 0.6
  if (pattern.kind !== 'inferred' || pattern.ts === null) return confidence
  const ageDays = Math.max(0, now / 86_400_000 - pattern.ts / 86_400)
  return confidence * Math.pow(0.5, ageDays / PATTERN_INFERRED_HALF_LIFE_DAYS)
}

function bigrams(value: string): Set<string> {
  const normalized = Array.from(value.toLowerCase()).filter(char => /[\p{L}\p{N}]/u.test(char)).join('')
  if (normalized.length < 2) return new Set(normalized ? [normalized] : [])
  return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)))
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0
  let common = 0
  for (const value of left) if (right.has(value)) common += 1
  return common / (left.size + right.size - common)
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (!left.length || left.length !== right.length || !right.every(Number.isFinite)) return 0
  let dot = 0, leftNorm = 0, rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!, b = right[index]!
    dot += a * b; leftNorm += a * a; rightNorm += b * b
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm)
}

function vectorMap(value: unknown, modelTag: string): Record<string, MemoryVector> {
  if (!object(value)) return {}
  const result: Record<string, MemoryVector> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!object(item) || item.t !== modelTag || !Array.isArray(item.v)
      || !item.v.length || !item.v.every(part => typeof part === 'number' && Number.isFinite(part))) continue
    result[key] = { v: item.v as number[], t: modelTag }
  }
  return result
}

function renderPatterns(patterns: Pattern[], query: string, now: number, queryVector?: readonly number[] | null,
  vectors: Record<string, MemoryVector> = {}): string {
  const scored = patterns.map(item => ({ item, effective: patternEffective(item, now) }))
    .filter(row => row.effective >= PATTERN_RETIRE_EFF)
  const byImportance = [...scored].sort((a, b) => b.effective * b.item.imp - a.effective * a.item.imp)
  let chosen = byImportance.slice(0, PATTERN_INJECT_MAX)
  if (query.trim() && scored.length > PATTERN_INJECT_MAX) {
    const queryBigrams = bigrams(query)
    const selected = new Set<Pattern>()
    chosen = []
    for (const row of byImportance.slice(0, PATTERN_FLOOR_K)) { chosen.push(row); selected.add(row.item) }
    const relevance = (item: Pattern) => queryVector
      ? cosine(queryVector, vectors[item.id ?? '']?.v ?? []) : jaccard(queryBigrams, bigrams(item.text))
    const related = scored.filter(row => !selected.has(row.item) && relevance(row.item) > 0)
      .sort((a, b) => relevance(b.item) + 0.1 * b.effective - relevance(a.item) - 0.1 * a.effective)
    for (const row of related) { if (chosen.length >= PATTERN_INJECT_MAX) break; chosen.push(row); selected.add(row.item) }
    for (const row of byImportance) { if (chosen.length >= PATTERN_INJECT_MAX) break; if (!selected.has(row.item)) chosen.push(row) }
  }
  return chosen.map(({ item, effective }) => `- ${item.text}${item.kind === 'inferred' && effective < 0.45 ? '（不太确定）' : ''}`).join('\n')
}

function retrieveMemory(text: string, vectors: Record<string, MemoryVector>, queryVector?: readonly number[] | null): string {
  if (text.length <= MEMORY_INJECT_CHARS) return text
  const fallback = latestMemorySuffix(text, MEMORY_INJECT_CHARS)
  if (!queryVector || !Object.keys(vectors).length) return fallback
  const chunks = splitUserMemoryVectorChunks(text)
  const covered = chunks.filter(chunk => vectors[userMemoryVectorChunkKey(chunk)]).length
  if (covered < Math.max(1, Math.floor(chunks.length / 2))) return fallback
  const ranked = chunks.map((chunk, index) => ({ chunk, index, score: cosine(queryVector, vectors[userMemoryVectorChunkKey(chunk)]?.v ?? []) }))
    .sort((a, b) => b.score - a.score)
  const picked: Array<{ chunk: string; index: number }> = []
  let used = 0
  for (const row of ranked) {
    const remaining = MEMORY_INJECT_CHARS - used
    if (remaining <= 0) break
    if (row.chunk.length > remaining) {
      if (!picked.length) picked.push({ chunk: row.chunk.slice(0, remaining).trimEnd(), index: row.index })
      break
    }
    picked.push({ chunk: row.chunk, index: row.index }); used += row.chunk.length
  }
  return picked.sort((a, b) => a.index - b.index).map(item => item.chunk).join('\n\n').slice(0, MEMORY_INJECT_CHARS).trimEnd()
}

function latestMemorySuffix(text: string, budget: number): string {
  const headings = [...text.matchAll(/^##\s+记录长期记忆：.+$/gmu)]
  if (!headings.length) return text.slice(-budget).trimStart()
  const sections = headings.flatMap((match, index) => {
    const start = match.index ?? 0
    const end = headings[index + 1]?.index ?? text.length
    const section = text.slice(start, end).trim()
    return section ? [section] : []
  })
  const selected: string[] = []
  let used = 0
  for (const section of sections.reverse()) {
    const separator = selected.length ? 2 : 0
    if (used + separator + section.length <= budget) { selected.push(section); used += separator + section.length; continue }
    if (!selected.length) return section.slice(0, budget).trimEnd()
    break
  }
  return selected.reverse().join('\n\n')
}

function renderLens(raw: unknown, now: number): string {
  const rules = object(raw) && Array.isArray(raw.rules) ? raw.rules : []
  const rendered = rules.flatMap(rule => {
    if (!object(rule)) return []
    const text = String(rule.rule ?? '').trim()
    const confidence = finite(rule.confidence) ?? 0
    const lastSeen = finite(rule.last_seen)
    const ageDays = lastSeen === null ? 0 : Math.max(0, now / 1000 / 86400 - lastSeen / 86400)
    const effective = confidence * Math.pow(0.5, ageDays / LENS_HALF_LIFE_DAYS)
    if (!text || effective < LENS_RETIRE_EFF) return []
    return [{ text, effective }]
  }).sort((a, b) => b.effective - a.effective).slice(0, LENS_MAX_RULES)
  if (!rendered.length) return ''
  const lines = rendered.map(({ text, effective }) => effective >= 0.6 ? `- ${text}`
    : effective >= 0.4 ? `-（多半）${text}` : `-（也许，留意但别笃定）${text}`)
  return '## 怎么读懂 TA（解读镜片 · 偏置不独裁）\n下面是相处里摸出的、读懂这个人的经验先验。用它**偏置**你的理解，但别当铁律——和当下语境冲突时以当下为准。\n' + lines.join('\n')
}

export async function readAgentMemorySummary(storage: AgentMemoryContextStorage, ownerId: string, signal?: AbortSignal) {
  const raw = await read(storage, ownerId, 'summary.json', 1_000_000, signal)
  const value = parse(raw)
  const summary = object(value) ? value : null
  if (summary) return { text: String(summary.text ?? '').trim(), ts: finite(summary.ts) }
  const [legacyText, legacyTs] = await Promise.all([
    read(storage, ownerId, 'summary.md', 1_000_000, signal), read(storage, ownerId, 'summary.ts', 100, signal),
  ])
  return { text: (legacyText ?? '').trim(), ts: finite((legacyTs ?? '').trim()) }
}

export async function readAgentMemoryStance(storage: AgentMemoryContextStorage, ownerId: string, signal?: AbortSignal) {
  const value = parse(await read(storage, ownerId, 'stance.json', 100_000, signal))
  const row = object(value) ? value : null
  return { stance: String(row?.stance ?? '').trim() || null, ts: finite(row?.ts) }
}

/** 对应 Python agent.memory.store.read_memory 的 Web snapshot 路径；只读当前 owner 的记忆文件。 */
export async function loadAgentMemoryContext(input: AgentMemoryContextInput): Promise<AgentMemoryContext> {
  input.signal?.throwIfAborted()
  if (!OWNER.test(input.ownerId)) throw new TypeError('记忆上下文 owner 无效')
  if (!input.storage || typeof input.storage.readText !== 'function' || !Number.isFinite(input.now)) throw new TypeError('记忆上下文读取参数无效')
  const [profile, patternRaw, factsRaw, factsMarkdown, memoryRaw, daily, summary, stance, lensRaw] = await Promise.all([
    readAgentMemoryProfile(input.storage, input.ownerId, input.signal), read(input.storage, input.ownerId, 'pattern.json', 2_000_000, input.signal),
    read(input.storage, input.ownerId, 'facts.json', 2_000_000, input.signal), read(input.storage, input.ownerId, 'facts.md', 2_000_000, input.signal),
    read(input.storage, input.ownerId, 'memory.md', FILE_LIMIT, input.signal), readAgentMemoryDaily(input.storage, input.ownerId, input.signal),
    readAgentMemorySummary(input.storage, input.ownerId, input.signal), readAgentMemoryStance(input.storage, input.ownerId, input.signal), read(input.storage, input.ownerId, 'lens.json', 1_000_000, input.signal),
  ])
  input.signal?.throwIfAborted()
  const patterns = readPatterns(patternRaw, factsRaw, factsMarkdown)
  const firstTs = patterns.map(pattern => pattern.ts).filter((value): value is number => value !== null && value !== 0).sort((a, b) => a - b)[0] ?? null
  const memory = (memoryRaw ?? '').trim()
  // Python checks the raw pattern count before the renderer applies retirement filtering.
  const patternOver = patterns.length > PATTERN_INJECT_MAX
  const memoryOver = memory.length > MEMORY_INJECT_CHARS
  let queryVector: readonly number[] | null = null
  let patternVectors: Record<string, MemoryVector> = {}
  let memoryVectors: Record<string, MemoryVector> = {}
  if (input.query && (patternOver || memoryOver) && input.vectorSearch) {
    const embedded = await input.vectorSearch.embed(input.ownerId, input.query, input.signal)
    if (embedded?.vector.length && embedded.modelTag) {
      queryVector = embedded.vector
      const [patternRawVectors, memoryRawVectors] = await Promise.all([
        patternOver ? input.vectorSearch.read(input.ownerId, 'pattern', input.signal) : Promise.resolve({}),
        memoryOver ? input.vectorSearch.read(input.ownerId, 'memory', input.signal) : Promise.resolve({}),
      ])
      input.signal?.throwIfAborted()
      patternVectors = vectorMap(patternRawVectors, embedded.modelTag)
      memoryVectors = vectorMap(memoryRawVectors, embedded.modelTag)
    }
  }
  const lensValue = parse(lensRaw)
  const lens = object(lensValue) ? lensValue : null
  const result: AgentMemoryContext = {
    profile, pattern: renderPatterns(patterns, input.query, input.now, queryVector, patternVectors),
    memory: retrieveMemory(memory, memoryVectors, queryVector),
    daily, summary: summary.text, summary_ts: summary.ts,
    first_ts: firstTs, stance: stance.stance, stance_ts: stance.ts, lens: renderLens(lens, input.now),
  }
  return result
}
