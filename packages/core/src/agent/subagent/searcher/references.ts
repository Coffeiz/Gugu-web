import { z } from 'zod'
import { createAgentShellTool } from '../../tools/shell/index.js'
import type { ToolResult } from '../../models.js'
import type { ToolDefinition, ToolScope } from '../../tools/contracts.js'

export function createSearcherReferenceSearch(list: (signal: AbortSignal, query?: string) => Promise<readonly { ref: string; label: string }[]>): ToolDefinition {
  const search = z.strictObject({ query: z.string().trim().max(512).optional(), types: z.array(z.enum(['file', 'folder'])).optional() })
  return {
    definition: { name: 'global_search', schema: { type: 'function', function: {
      name: 'global_search', description: '在已经委派的文件引用中按名称搜索，返回可读取的引用键。',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    } } },
    effect: 'read', validate: input => search.safeParse(input),
    async execute(input, scope) {
      const { query } = search.parse(input)
      const entries = await list(scope.signal, query)
      const term = query?.toLowerCase() ?? ''
      return { kind: 'completed', successful: true, mutated: false, value: entries.filter(entry => entry.label.toLowerCase().includes(term)) }
    },
  }
}

export function createSearcherReferenceShell(read: (ref: string, scope: ToolScope, maxOutputChars: number) => Promise<ToolResult>) {
  return createAgentShellTool(async (input, scope) => {
    const match = /^cat[ \t]+--[ \t]+([a-f0-9]{24}|[1-9][0-9]{0,9})$/u.exec(input.command)
    if (input.cwd !== '.' || !match) return {
      kind: 'completed', successful: false, executed: false, mutated: false,
      value: { error: '文件委派仅允许使用 cat -- 引用键 读取已授权文件' },
    }
    return read(match[1]!, scope, input.max_output_chars)
  }, '读取本轮委派的文件。使用 cat -- 引用键，只接受单个已授权的文件引用。', false)
}
