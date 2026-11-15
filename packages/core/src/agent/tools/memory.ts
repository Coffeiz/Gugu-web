import { z } from 'zod'
import type { RunIdentity } from '../models.js'
import type { ToolDefinition } from './contracts.js'
import type { MemorySearchRequest } from '../rag/memory-search.js'
import { MemorySearchAccessError } from '../rag/memory-search.js'

export interface MemorySearchPort {
  search(identity: RunIdentity, request: MemorySearchRequest, signal: AbortSignal): Promise<Record<string, unknown>>
}

const schema = z.object({
  query: z.string(),
  scope: z.enum(['auto', 'current_group', 'all_my_groups', 'private_memory']).optional(),
  source: z.enum(['all', 'profile', 'pattern', 'daily', 'memory']).optional(),
  strategy: z.enum(['auto', 'bm25', 'embedding']).optional(),
  limit: z.number().int().min(1).max(25).optional(),
}).passthrough()

/** 公开搜索只接受范围选择，不接受 owner/group/member 身份字段。 */
export function createMemorySearchTool(port: MemorySearchPort): ToolDefinition {
  return {
    definition: { name: 'search_memory', schema: { type: 'function', function: { name: 'search_memory',
      description: '搜索个人或已授权群聊记忆；记忆索引更新可能有短暂延迟。',
      parameters: { type: 'object', properties: {
        query: { type: 'string' }, scope: { type: 'string', enum: ['auto', 'current_group', 'all_my_groups', 'private_memory'] },
        source: { type: 'string', enum: ['all', 'profile', 'pattern', 'daily', 'memory'] },
        strategy: { type: 'string', enum: ['auto', 'bm25', 'embedding'] }, limit: { type: 'integer', minimum: 1, maximum: 25 },
      }, required: ['query'] } } } }, effect: 'read', validate: input => schema.safeParse(input),
    async execute(input, scope) {
      try {
        const value = await port.search(scope.identity, input as MemorySearchRequest, scope.signal)
        scope.signal.throwIfAborted()
        return { kind: 'completed', successful: true, mutated: false, value }
      } catch (error) {
        if (!(error instanceof MemorySearchAccessError)) throw error
        return { kind: 'completed', successful: false, mutated: false, executed: true, value: { error: error.message } }
      }
    },
  }
}
