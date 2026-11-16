import { z } from 'zod'
import type { RunIdentity } from '../models.js'
import type { ToolDefinition } from './contracts.js'

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

const schema = z.object({
  knowledge_id: z.string().optional(),
  keyword: z.string().optional(),
  scope: z.string().optional(),
  limit: z.number().int().min(1).max(25).optional(),
}).passthrough().refine(value => Boolean(value.knowledge_id?.trim()) !== Boolean(value.keyword?.trim()))

/** 对齐 Python read_knowledge：按 ID 直读，关键词查询走统一 BM25 索引。 */
export function createKnowledgeReadTool(port: KnowledgeReadPort): ToolDefinition {
  return {
    definition: { name: 'read_knowledge', schema: { type: 'function', function: {
      name: 'read_knowledge',
      description: '按 knowledge_id 精确读取知识，或用 keyword 通过 BM25 搜索知识条目。',
      parameters: { type: 'object', properties: {
        knowledge_id: { type: 'string' }, keyword: { type: 'string' }, scope: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      }, oneOf: [{ required: ['knowledge_id'], not: { required: ['keyword'] } }, { required: ['keyword'], not: { required: ['knowledge_id'] } }] },
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
      if (!keyword) return { kind: 'completed', successful: false, mutated: false, value: { error: '请提供 keyword 进行 BM25 检索，或提供 knowledge_id 精确读取完整条目' } }
      const recall = await port.search(scope.identity, keyword, args.scope?.trim().toLowerCase() ?? '', args.limit ?? 5, scope.signal)
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
