import { randomBytes } from 'node:crypto'
import { strip } from '../../../shared/values.js'
import { applyRememberEdit, PROFILE_TYPES, type RememberInput, type MemoryRow } from '../../memory/remember.js'
import { z } from 'zod'
import type { RunIdentity, ToolResult } from '../../models.js'
import type { ToolDefinition } from '../contracts.js'
import type { MemorySearchRequest } from '../../rag/memory-search.js'
import { MemorySearchAccessError } from '../../rag/memory-search.js'

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

export interface RememberMemoryPort {
  /** 原子读取和比较更新 owner 文件，以 Run 调用坐标记收据，并推进索引/向量更新。 */
  mutate(identity: RunIdentity & { roundId: string; toolCallId: string }, input: RememberInput, signal: AbortSignal,
    edit: (rows: readonly MemoryRow[]) => ReturnType<typeof applyRememberEdit>): Promise<ToolResult>
  reconcile(identity: RunIdentity & { roundId: string; toolCallId: string }, input: RememberInput): Promise<ToolResult>
}

const rememberSchema = z.object({
  text: z.string().optional(), target: z.enum(['profile', 'pattern']).optional(),
  type: z.enum(PROFILE_TYPES).optional(), importance: z.number().int().min(1).max(5).optional(),
  remove: z.array(z.string()).optional(),
}).strict()

function rememberInput(raw: unknown): RememberInput {
  const input = raw as z.infer<typeof rememberSchema>
  return { ...input, target: input.target ?? 'profile', text: strip(input.text ?? ''), remove: (input.remove ?? []).map(strip).filter(Boolean) }
}

export function createRememberTool(port: RememberMemoryPort, nowSeconds: () => number): ToolDefinition {
  return {
    definition: { name: 'remember', schema: { type: 'function', function: {
      name: 'remember', description: '记住或忘记个人信息。默认写入画像，也可写行为模式。可先用 search_memory 查找需要删除的条目。',
      parameters: { type: 'object', properties: {
        text: { type: 'string' }, target: { type: 'string', enum: ['profile', 'pattern'] },
        type: { type: 'string', enum: [...PROFILE_TYPES] }, importance: { type: 'integer', minimum: 1, maximum: 5 },
        remove: { type: 'array', items: { type: 'string' } },
      } },
    } } },
    effect: 'write', validate: input => rememberSchema.safeParse(input),
    async execute(raw, scope, call) {
      scope.signal.throwIfAborted()
      const input = rememberInput(raw)
      if (!input.text && !input.remove.length) return { kind: 'completed', successful: false, mutated: false,
        value: { error: '需要提供要记住的内容 text，或要忘记的条目列表 remove' } }
      return port.mutate({ ...scope.identity, roundId: scope.roundId, toolCallId: call.id }, input, scope.signal,
        rows => applyRememberEdit(rows, input, nowSeconds(), () => randomBytes(3).toString('hex')))
    },
    async reconcile(raw, identity, call) {
      return port.reconcile({ ...identity, toolCallId: call.id }, rememberInput(raw))
    },
  }
}
