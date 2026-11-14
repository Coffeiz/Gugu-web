import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'
import type { GlobalSearchOperations, GlobalSearchType } from '../search/search.js'
import { parsePythonInteger } from '../../http/request.js'

export interface MindRefSuggestItem {
  type: string
  id: number | string
  label: string
  subtitle?: string | null
}

export interface MindRefSuggestOperations {
  suggest(ownerId: string, query: string, limit: number): Promise<MindRefSuggestItem[]>
}

export interface MindRefSuggestOptions {
  ownerId(request: FastifyRequest): string
  operations: MindRefSuggestOperations
}

const referenceTypes: GlobalSearchType[] = [
  'project', 'file', 'folder', 'event', 'canvas_note', 'skill', 'mcp', 'scheduled_task',
]

function queryString(value: unknown): string | null {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : null
}

export function registerMindRefSuggestRoute(app: FastifyInstance, options: MindRefSuggestOptions): void {
  app.get('/api/v1/mind/ref-suggest', async (request, reply) => {
    const raw = request.query && typeof request.query === 'object' && !Array.isArray(request.query)
      ? request.query as Record<string, unknown>
      : {}
    const query = queryString(raw.q)
    if (query === null) return reply.code(422).send({ detail: 'q 必须是字符串' })
    const rawLimit = raw.limit === undefined ? '6' : raw.limit
    const limit = parsePythonInteger(rawLimit)
    if (typeof limit !== 'number' || limit < 1 || limit > 20)
      return reply.code(422).send({ detail: 'limit 必须是 1 到 20 之间的整数' })
    return options.operations.suggest(options.ownerId(request), query, limit)
  })
}

export const MIND_REF_SUGGEST_TYPES = referenceTypes
