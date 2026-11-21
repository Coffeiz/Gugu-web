import { z } from 'zod'
import { GLOBAL_SEARCH_TYPES, parseGlobalSearchQuery } from '../../search/query.js'
import type { GlobalSearchOperations } from '../../search/global-search.js'
import type { ToolDefinition } from './contracts.js'

const inputSchema = z.object({
  query: z.string().optional(), q: z.string().optional(),
  queries: z.array(z.string()).optional(),
  mode: z.enum(['OR', 'AND']).optional(),
  types: z.array(z.enum(GLOBAL_SEARCH_TYPES)).optional(),
})
const noMatches = '没搜到任何匹配——除思维便签(note)搜正文外，其余类型只按名称/标题/联系人名等字段匹配，不搜文件内容；搜不到不代表数据库里真的没有相关内容，只是名字/标题对不上关键词'

/** Host 注入共享搜索服务；模型不能设置 owner、来源能力或每类结果上限。 */
export function createGlobalSearchTool(search: GlobalSearchOperations, useAvailableSources = false): ToolDefinition {
  return {
    definition: { name: 'global_search', schema: { type: 'function', function: {
      name: 'global_search', description: '跨项目、文件、日程、联系人、对话、便签和当前用户 Skill 按关键词搜索；明确范围时用专用工具。Skill 结果只返回 ID、名称和描述，不返回正文或关联权限。',
      parameters: { type: 'object', properties: {
        query: { type: 'string' }, q: { type: 'string' }, queries: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['OR', 'AND'] }, types: { type: 'array', items: { type: 'string', enum: [...GLOBAL_SEARCH_TYPES] } },
      }, required: [] },
    } } },
    effect: 'read',
    validate(input) {
      const parsed = inputSchema.safeParse(input)
      return parsed.success ? { success: true, data: parsed.data } : { success: false }
    },
    async execute(input, scope) {
      scope.signal.throwIfAborted()
      const args = input as z.infer<typeof inputSchema>
      const query = parseGlobalSearchQuery({ q: args.query || args.q || '', queries: args.queries, mode: args.mode,
        types: args.types, per_type: '20' })
      if (!query.queries.length) return { kind: 'completed', successful: false, mutated: false,
        value: { error: '需要提供搜索关键词 query 或 queries' } }
      const types = query.types ?? (useAvailableSources ? search.availableTypes : GLOBAL_SEARCH_TYPES)
      const missing = types.filter(type => !search.availableTypes.includes(type))
      if (missing.length) return { kind: 'completed', successful: false, mutated: false,
        value: { error: '当前平台未提供所请求的搜索来源', unavailable_types: missing } }
      const value = await search.search(scope.identity.ownerId,
        useAvailableSources && query.types === null ? { ...query, types } : query, { signal: scope.signal })
      scope.signal.throwIfAborted()
      if (!value || typeof value !== 'object' || !('groups' in value) || !Array.isArray(value.groups))
        return { kind: 'completed', successful: true, mutated: false, value }
      // 分组类型属于搜索元数据。媒体块的 type 保留给持久化编解码器。
      const groups = value.groups.map(({ type, ...group }) => ({ ...group, source_type: type }))
      return { kind: 'completed', successful: true, mutated: false,
        value: { ...value, groups, ...('total' in value && value.total === 0 ? { note: noMatches } : {}) } }
    },
  }
}
