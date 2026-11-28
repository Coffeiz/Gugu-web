import { dataContext } from '../../contracts/index.js'

export type AgentKnowledgeSourceType = 'user' | 'file' | 'web' | 'derived' | 'conversation'
export type AgentKnowledgeConfidence = 'confirmed' | 'probable' | 'unverified' | 'conflict'
export interface AgentKnowledgeScope {
  type: string
  owner_user_id: string
  platform: string
  bot_id: string
  group_id: string
  scope_id: string
  project_id: string
}
export interface AgentKnowledgeSource {
  type: AgentKnowledgeSourceType
  ref: string
  label: string
  checked_at: number | null
}
export interface AgentKnowledgeHistory {
  version: number
  title: string
  content: string
  keywords: string[]
  source: AgentKnowledgeSource
  confidence: string
  updated_at: number
}
export interface AgentKnowledgeEntry {
  id: string
  title: string
  content: string
  topic: string
  keywords: string[]
  description: string
  scope: AgentKnowledgeScope
  source: AgentKnowledgeSource
  confidence: AgentKnowledgeConfidence
  version: number
  parent_id: string | null
  created_at: number
  updated_at: number
  active: boolean
  history: AgentKnowledgeHistory[]
}

const SOURCES = new Set<AgentKnowledgeSourceType>(['user', 'file', 'web', 'derived', 'conversation'])
const CONFIDENCES = new Set<AgentKnowledgeConfidence>(['confirmed', 'probable', 'unverified', 'conflict'])
const MAX_HISTORY = 5
const compact = (value: unknown) => JSON.stringify(value)
function json(fields: Record<string, string>, name: string): unknown {
  try { return JSON.parse(fields[name] ?? '') } catch { return undefined }
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d(?::?\d\d)?)$/iu.test(value)) throw new Error('知识时间无效')
  const parsed = Date.parse(value.replace(/([+-]\d\d)$/u, '$1:00'))
  if (!Number.isFinite(parsed)) throw new Error('知识时间无效')
  const fraction = /\.(\d+)(?=Z|[+-]\d\d(?::?\d\d)?$)/iu.exec(value)?.[1]
  if (!fraction) return parsed / 1000
  const micros = Number((fraction.slice(0, 6)).padEnd(6, '0'))
  const parsedMillis = Number(fraction.slice(0, 3).padEnd(3, '0'))
  return parsed / 1000 + (micros - parsedMillis * 1000) / 1_000_000
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function source(value: unknown): AgentKnowledgeSource {
  if (!object(value) || typeof value.type !== 'string' || !SOURCES.has(value.type as AgentKnowledgeSourceType)) throw new Error('知识来源无效')
  return {
    type: value.type as AgentKnowledgeSourceType,
    ref: typeof value.ref === 'string' ? value.ref : '',
    label: typeof value.label === 'string' ? value.label : '',
    checked_at: value.checked_at == null ? null : typeof value.checked_at === 'number' ? value.checked_at : timestamp(value.checked_at),
  }
}
function scope(value: unknown): AgentKnowledgeScope {
  if (!object(value) || typeof value.owner_user_id !== 'string') throw new Error('知识范围无效')
  return {
    type: typeof value.type === 'string' ? value.type : 'owner',
    owner_user_id: dataContext(value.owner_user_id).ownerId,
    platform: typeof value.platform === 'string' ? value.platform : '',
    bot_id: typeof value.bot_id === 'string' ? value.bot_id : '',
    group_id: typeof value.group_id === 'string' ? value.group_id : '',
    scope_id: typeof value.scope_id === 'string' ? value.scope_id : '',
    project_id: typeof value.project_id === 'string' ? value.project_id : '',
  }
}

/** 解析 Python KnowledgeStore 的 Markdown frontmatter；主数据仍由 Host 授权 FS 保存。 */
export function parseAgentKnowledgeEntry(raw: Uint8Array): AgentKnowledgeEntry {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  if (!text.startsWith('---\n')) throw new Error('知识文件缺少 frontmatter')
  const marker = text.indexOf('\n---\n', 4)
  if (marker < 0) throw new Error('知识文件 frontmatter 未闭合')
  const fields: Record<string, string> = Object.create(null)
  for (const line of text.slice(4, marker).split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replaceAll('\\n', '\n').replaceAll('\\\\', '\\')
  }
  const id = fields.id ?? ''
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error('知识标识无效')
  const keywords = json(fields, 'keywords_json'), history = json(fields, 'history_json') ?? []
  const parsedScope = scope(json(fields, 'scope_json'))
  const parsedSource = source(json(fields, 'source_json'))
  const version = Number(fields.version ?? '1')
  const confidence = (fields.confidence || 'confirmed') as AgentKnowledgeConfidence
  if (!Array.isArray(keywords) || keywords.some(item => typeof item !== 'string') || !Array.isArray(history)
    || !Number.isSafeInteger(version) || version < 1 || !CONFIDENCES.has(confidence)) throw new Error('知识记录无效')
  const content = text.slice(marker + '\n---\n'.length).replace(/^\n/u, '').replace(/\n+$/u, '')
  return {
    id, title: fields.title ?? '', topic: fields.topic ?? '', content,
    keywords: keywords as string[], description: fields.description ?? '', scope: parsedScope, source: parsedSource,
    confidence, version, parent_id: fields.parent_id || null,
    created_at: timestamp(fields.created_at), updated_at: timestamp(fields.updated_at),
    active: (fields.active ?? 'true').toLowerCase() === 'true',
    history: history.flatMap(item => {
      if (!object(item) || !Number.isSafeInteger(Number(item.version)) || typeof item.title !== 'string'
        || typeof item.content !== 'string' || !Array.isArray(item.keywords) || item.keywords.some(value => typeof value !== 'string')) return []
      try { return [{ version: Number(item.version), title: item.title, content: item.content, keywords: item.keywords as string[], source: source(item.source), confidence: String(item.confidence ?? ''), updated_at: typeof item.updated_at === 'number' ? item.updated_at : timestamp(item.updated_at) }] }
      catch { return [] }
    }).slice(-MAX_HISTORY),
  }
}

function frontmatter(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n') }
function iso(value: number): string {
  if (!Number.isFinite(value)) throw new Error('知识时间无效')
  const micros = Math.round(value * 1_000_000)
  const seconds = Math.floor(micros / 1_000_000)
  const fraction = String(micros - seconds * 1_000_000).padStart(6, '0')
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${fraction}Z`
}

/** 输出与 Python `_serialize` 相同的字段次序和转义，Host 再通过原子 FS 写入。 */
export function serializeAgentKnowledgeEntry(entry: AgentKnowledgeEntry): Uint8Array {
  const normalized: AgentKnowledgeEntry = { ...entry, history: entry.history.slice(-MAX_HISTORY) }
  const metadata: Array<[string, string]> = [
    ['id', frontmatter(normalized.id)], ['title', frontmatter(normalized.title)], ['topic', frontmatter(normalized.topic)],
    ['keywords_json', compact(normalized.keywords)], ['description', frontmatter(normalized.description)],
    ['scope_json', compact(normalized.scope)], ['source_json', compact({ ...normalized.source, checked_at: normalized.source.checked_at == null ? null : iso(normalized.source.checked_at) })],
    ['confidence', frontmatter(normalized.confidence)], ['version', String(normalized.version)], ['parent_id', frontmatter(normalized.parent_id ?? '')],
    ['created_at', iso(normalized.created_at)], ['updated_at', iso(normalized.updated_at)], ['active', String(normalized.active)],
    ['history_json', compact(normalized.history.map(item => ({ ...item, source: { ...item.source, checked_at: item.source.checked_at == null ? null : iso(item.source.checked_at) }, updated_at: iso(item.updated_at) })))],
  ]
  return new TextEncoder().encode(`---\n${metadata.map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n${normalized.content}\n`)
}
