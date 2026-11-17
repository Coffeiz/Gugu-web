import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { dataContext } from '../../contracts/index.js'
import { serializeAgentKnowledgeEntry } from '../knowledge/entry.js'
import type { AgentKnowledgeEntry, AgentKnowledgeSourceType } from '../knowledge/entry.js'
import type { RunIdentity } from '../models.js'
import type { ToolDefinition } from './contracts.js'
import type { ToolResult } from '../models.js'

export interface KnowledgeReadEntry {
  knowledge_id: string
  title: string
  topic: string
  description: string
  keywords: string[]
  confidence: string
  source_type: string
  scope_type: string
  created_at: string
  updated_at: string
  content: string
  version: number
}

export interface KnowledgeSearchHit {
  knowledge_id: string
  title: string
  topic: string
  description: string
  keywords: string
  confidence: string
  source_type: string
  source_ref: string
  source_label: string
  content: string
  score: number | null
  updated_at: string
  version: string
}

/** Store 与检索授权都由 Host 注入；模型不能传 owner、授权根或凭据。 */
export interface KnowledgeReadPort {
  read(identity: RunIdentity, knowledgeId: string, signal: AbortSignal): Promise<KnowledgeReadEntry | null>
  search(identity: RunIdentity, keyword: string, scope: string, limit: number, signal: AbortSignal): Promise<{
    results: KnowledgeSearchHit[]
    has_more: boolean
  }>
}

/** 文件主数据和索引新鲜度由可信 Host 提供；模型不能选择 owner 或 FS 路径。 */
export interface KnowledgeWritePort {
  list(identity: RunIdentity, signal: AbortSignal): Promise<AgentKnowledgeEntry[]>
  /** Host 按 owner 原子写入，并先撤回旧索引、成功后再排入持久重建。 */
  commit(identity: RunIdentity, entry: AgentKnowledgeEntry, signal: AbortSignal): Promise<void>
}

const writeSchema = z.object({
  title: z.unknown().optional(), content: z.unknown().optional(), topic: z.unknown().optional(),
  keywords: z.unknown().optional(), description: z.unknown().optional(), source_type: z.unknown().optional(),
  source_ref: z.unknown().optional(), source_label: z.unknown().optional(), confidence: z.unknown().optional(),
  capture_mode: z.unknown().optional(), knowledge_id: z.unknown().optional(),
}).passthrough()

const sourceTypes = new Set<AgentKnowledgeSourceType>(['user', 'file', 'web', 'derived', 'conversation'])
const confidenceTypes = new Set(['confirmed', 'probable', 'unverified'])
const captureModes = new Set(['explicit', 'tool_result', 'automatic'])
const textValue = (value: unknown) => typeof value === 'string' ? value.trim() : ''
// Python KnowledgeStore._norm removes all whitespace and uses casefold().
const normalizedText = (value: string) => value.replace(/\s+/gu, '').toLocaleLowerCase('und')
const characterLength = (value: string) => Array.from(value).length
function normalizedKeywords(value: unknown, stringifyScalars: boolean): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = [], seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' && !(stringifyScalars && (typeof item === 'number' && Number.isFinite(item)))) continue
    const keyword = (typeof item === 'string' ? item : String(item)).replace(/\s+/gu, ' ').trim()
    const key = keyword.toLocaleLowerCase('und')
    if (!keyword || characterLength(keyword) > 40 || seen.has(key)) continue
    result.push(keyword); seen.add(key)
    if (result.length === 10) break
  }
  return result
}
function captureValues(input: Record<string, unknown>) {
  const title = textValue(input.title), content = textValue(input.content), topic = textValue(input.topic)
  const description = textValue(input.description).replace(/\s+/gu, ' ')
  const sourceType = textValue(input.source_type || 'user').toLowerCase()
  const confidence = textValue(input.confidence || 'confirmed').toLowerCase()
  const captureMode = textValue(input.capture_mode || 'explicit').toLowerCase()
  const sourceRef = textValue(input.source_ref), sourceLabel = textValue(input.source_label)
  if (!title || !content) throw new Error('需要提供 title 和 content')
  if (!sourceTypes.has(sourceType as AgentKnowledgeSourceType)) throw new Error('source_type 只能是 user、file、web、derived 或 conversation')
  if (!confidenceTypes.has(confidence)) throw new Error('confidence 只能是 confirmed、probable 或 unverified')
  if (!captureModes.has(captureMode)) throw new Error('capture_mode 只能是 explicit、tool_result 或 automatic')
  for (const [name, value, limit] of [['title', title, 80], ['topic', topic, 40], ['content', content, 3000],
    ['source_ref', sourceRef, 300], ['source_label', sourceLabel, 120], ['description', description, 150]] as const) {
    if (characterLength(value) > limit) throw new Error(`${name} 不能超过 ${limit} 个字符`)
  }
  return { title, content, topic, description, sourceType: sourceType as AgentKnowledgeSourceType, sourceRef, sourceLabel,
    confidence: captureMode === 'explicit' ? confidence : 'probable', keywords: normalizedKeywords(input.keywords, false) }
}

function updateEntry(entries: AgentKnowledgeEntry[], current: AgentKnowledgeEntry | null, values: ReturnType<typeof captureValues>, ownerId: string, now: number): AgentKnowledgeEntry {
  const entry: AgentKnowledgeEntry = current ? { ...current,
    title: values.title, content: values.content, topic: values.topic, description: values.description,
    keywords: values.keywords.length ? values.keywords : [...current.keywords],
    confidence: values.confidence as AgentKnowledgeEntry['confidence'], updated_at: now,
  } : {
    id: randomUUID().replaceAll('-', ''), title: values.title, content: values.content, topic: values.topic,
    keywords: values.keywords, description: values.description,
    scope: { type: 'owner', owner_user_id: ownerId, platform: '', bot_id: '', group_id: '', scope_id: '', project_id: '' },
    source: { type: values.sourceType, ref: values.sourceRef, label: values.sourceLabel, checked_at: null },
    confidence: values.confidence as AgentKnowledgeEntry['confidence'], version: 1, parent_id: null,
    created_at: now, updated_at: now, active: true, history: [],
  }
  if (current) {
    const sameContent = normalizedText(current.content) === normalizedText(entry.content)
    const sameKeywords = current.keywords.length === entry.keywords.length && current.keywords.every((item, index) => item === entry.keywords[index])
    const sameDescription = normalizedText(current.description) === normalizedText(entry.description)
    if (sameContent && sameKeywords && sameDescription) return current
    entry.version = current.version + 1
    entry.created_at = current.created_at
    if (!sameContent) entry.history = [...current.history, {
      version: current.version, title: current.title, content: current.content, keywords: [...current.keywords], source: { ...current.source },
      confidence: current.confidence, updated_at: current.updated_at,
    }].slice(-5)
  } else {
    const candidates = entries.filter(item => item.active && item.scope.type === 'owner'
      && item.topic && values.topic && normalizedText(item.topic) === normalizedText(values.topic))
    const sameTopic = candidates.find(item => item.source.type === values.sourceType) ?? candidates[0]
    if (sameTopic) {
      if (!entry.keywords.length) entry.keywords = [...sameTopic.keywords]
      const sameContent = normalizedText(sameTopic.content) === normalizedText(entry.content)
      const sameKeywords = sameTopic.keywords.length === entry.keywords.length && sameTopic.keywords.every((item, index) => item === entry.keywords[index])
      const sameDescription = normalizedText(sameTopic.description) === normalizedText(entry.description)
      if (sameContent && sameKeywords && sameDescription) return sameTopic
      if (sameContent) {
        entry.id = sameTopic.id
        entry.version = sameTopic.version + 1
        entry.created_at = sameTopic.created_at
        entry.parent_id = sameTopic.parent_id
        entry.history = [...sameTopic.history]
      } else if (values.sourceType !== 'user' && sameTopic.source.type !== values.sourceType) {
        entry.confidence = 'conflict'
        entry.parent_id = sameTopic.id
      } else {
        entry.id = sameTopic.id
        entry.version = sameTopic.version + 1
        entry.created_at = sameTopic.created_at
        entry.history = [...sameTopic.history, {
          version: sameTopic.version, title: sameTopic.title, content: sameTopic.content, keywords: [...sameTopic.keywords],
          source: { ...sameTopic.source }, confidence: sameTopic.confidence, updated_at: sameTopic.updated_at,
        }].slice(-5)
      }
    }
  }
  return entry
}

function toolFailure(error: string): ToolResult {
  return { kind: 'completed', successful: false, mutated: false, executed: true, value: { error } }
}

/** Python `save_knowledge` 与 `update_knowledge` 的共享工具组；删除等待确认端口迁移后再开放。 */
export function createKnowledgeWriteTools(port: KnowledgeWritePort, now: () => number = () => Date.now() / 1000): ToolDefinition[] {
  if (!port || typeof port.list !== 'function' || typeof port.commit !== 'function') throw new TypeError('知识写入端口未装配')
  const save: ToolDefinition = {
    definition: { name: 'save_knowledge', schema: { type: 'function', function: { name: 'save_knowledge',
      description: '保存或更新可复用知识；保存前先通过 read_knowledge 查重，已存在时优先使用 update_knowledge。',
      parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string', maxLength: 3000 }, topic: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } }, description: { type: 'string', maxLength: 150 },
        source_type: { type: 'string', enum: [...sourceTypes] }, source_ref: { type: 'string' }, source_label: { type: 'string' },
        confidence: { type: 'string', enum: ['confirmed', 'probable', 'unverified'] }, capture_mode: { type: 'string', enum: ['explicit', 'tool_result', 'automatic'] } },
      required: ['title', 'content'] } } } }, effect: 'write', validate: input => writeSchema.safeParse(input),
    async execute(input, scope) {
      let values: ReturnType<typeof captureValues>
      try { values = captureValues(input as Record<string, unknown>) }
      catch (error) { return toolFailure(error instanceof Error ? error.message : '知识参数无效') }
      const owner = dataContext(scope.identity.ownerId).ownerId
      scope.signal.throwIfAborted()
      const entries = await port.list(scope.identity, scope.signal)
      scope.signal.throwIfAborted()
      const entry = updateEntry(entries, null, values, owner, now())
      if (!Number.isFinite(entry.updated_at)) return toolFailure('知识时间无效')
      const projected = [...entries.filter(item => item.id !== entry.id), entry]
      if (projected.reduce((sum, item) => sum + serializeAgentKnowledgeEntry(item).byteLength, 0) > 32 * 1024 * 1024) return toolFailure('Knowledge 总量不能超过 32 MB')
      await port.commit(scope.identity, entry, scope.signal)
      return { kind: 'completed', successful: true, mutated: true, value: { success: true, id: entry.id, title: entry.title,
        source_type: entry.source.type, confidence: entry.confidence, index_status: 'queued' } }
    },
  }
  const update: ToolDefinition = {
    definition: { name: 'update_knowledge', schema: { type: 'function', function: { name: 'update_knowledge',
      description: '更新一条知识；content 省略时只更新元数据，必须使用 read_knowledge 返回的 knowledge_id。',
      parameters: { type: 'object', properties: { knowledge_id: { type: 'string' }, content: { type: 'string', maxLength: 3000 },
        title: { type: 'string' }, topic: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } },
        description: { type: 'string', maxLength: 150 }, confidence: { type: 'string' } }, required: ['knowledge_id'] } } } },
    effect: 'write', validate: input => writeSchema.safeParse(input),
    async execute(input, scope) {
      const args = input as Record<string, unknown>, id = textValue(args.knowledge_id)
      if (!id) return toolFailure('需要提供 knowledge_id；先用 read_knowledge 查询获取')
      const entries = await port.list(scope.identity, scope.signal)
      scope.signal.throwIfAborted()
      const current = entries.find(item => item.id === id && item.active && item.scope.type === 'owner')
      if (!current) return toolFailure('知识条目不存在或已删除；先用 read_knowledge 查询获取有效的 knowledge_id')
      const confidence = textValue(args.confidence || current.confidence).toLowerCase()
      let values: ReturnType<typeof captureValues>
      try {
        values = captureValues({ title: args.title || current.title, content: textValue(args.content) || current.content,
          topic: args.topic || current.topic, description: textValue(args.description) || current.description,
          keywords: Array.isArray(args.keywords) ? args.keywords.filter(item => typeof item === 'string' || typeof item === 'number') : current.keywords,
          source_type: current.source.type, source_ref: current.source.ref, source_label: current.source.label,
          confidence: confidenceTypes.has(confidence) ? confidence : 'probable', capture_mode: 'explicit' })
      } catch (error) { return toolFailure(error instanceof Error ? error.message : '知识参数无效') }
      const next = updateEntry(entries, current, values, dataContext(scope.identity.ownerId).ownerId, now())
      const unchanged = next.version === current.version
      if (!unchanged) {
        const projected = [...entries.filter(item => item.id !== current.id), next]
        if (projected.reduce((sum, item) => sum + serializeAgentKnowledgeEntry(item).byteLength, 0) > 32 * 1024 * 1024)
          return toolFailure('Knowledge 总量不能超过 32 MB')
      }
      // Python publishes RagIndexUpdated even when persistence keeps the same version.
      await port.commit(scope.identity, next, scope.signal)
      return { kind: 'completed', successful: true, mutated: true, value: { success: true, id: next.id, version: next.version,
        title: next.title, keywords: next.keywords, unchanged, previous: { version: current.version, content: Array.from(current.content).slice(0, 300).join('') },
        index_status: 'queued' } }
    },
  }
  return [save, update]
}

const schema = z.object({
  knowledge_id: z.string().optional(),
  keyword: z.string().optional(),
  scope: z.string().optional(),
  limit: z.number().int().optional(),
}).passthrough()

/** 对齐 Python read_knowledge：按 ID 直读，关键词查询走统一 BM25 索引。 */
export function createKnowledgeReadTool(port: KnowledgeReadPort): ToolDefinition {
  return {
    definition: { name: 'read_knowledge', schema: { type: 'function', function: {
      name: 'read_knowledge',
      description: '按 knowledge_id 精确读取知识，或用 keyword 通过 BM25 搜索知识条目。',
      parameters: { type: 'object', properties: {
        knowledge_id: { type: 'string' }, keyword: { type: 'string' }, scope: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      } },
    } } }, effect: 'read', validate: input => schema.safeParse(input),
    async execute(input, scope) {
      const args = input as z.infer<typeof schema>
      const knowledgeId = args.knowledge_id?.trim() ?? ''
      if (knowledgeId) {
        const entry = await port.read(scope.identity, knowledgeId, scope.signal)
        scope.signal.throwIfAborted()
        return entry
          ? { kind: 'completed', successful: true, mutated: false, value: { success: true, entry } }
          : { kind: 'completed', successful: false, mutated: false, value: { error: '知识条目不存在或已停用；可用 keyword 进行 BM25 搜索' } }
      }
      const keyword = args.keyword?.trim() ?? ''
      if (!keyword) return { kind: 'completed', successful: false, mutated: false, executed: true, value: { error: '请提供 keyword 进行 BM25 检索，或提供 knowledge_id 精确读取完整条目' } }
      const limit = args.limit || 5
      if (limit < 1 || limit > 25) return { kind: 'completed', successful: false, mutated: false, executed: true, value: { error: 'limit 必须是 1 到 25 的整数' } }
      const recall = await port.search(scope.identity, keyword, args.scope?.trim().toLowerCase() ?? '', limit, scope.signal)
      scope.signal.throwIfAborted()
      const grouped = new Map<string, KnowledgeSearchHit>()
      for (const hit of recall.results) {
        if (!hit.knowledge_id) continue
        const previous = grouped.get(hit.knowledge_id)
        if (!previous) grouped.set(hit.knowledge_id, { ...hit })
        else if (hit.content && !previous.content.includes(hit.content)) previous.content = `${previous.content}\n\n${hit.content}`.trim()
      }
      const entries = [...grouped.values()]
      const value: Record<string, unknown> = {
        success: true, query: keyword, strategy: 'bm25', returned: entries.length,
        has_more: recall.has_more, entries,
      }
      if (!entries.length) value.note = 'BM25 索引中没有命中；刚保存或更新的知识可能尚未完成索引同步'
      return { kind: 'completed', successful: true, mutated: false, value }
    },
  }
}
