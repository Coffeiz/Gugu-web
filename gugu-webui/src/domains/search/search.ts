import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export const GLOBAL_SEARCH_TYPES = [
  'project', 'file', 'folder', 'event', 'client', 'conversation', 'note',
  'canvas_note', 'skill', 'mcp', 'scheduled_task',
] as const

export type GlobalSearchType = typeof GLOBAL_SEARCH_TYPES[number]

export interface GlobalSearchQuery {
  q: string
  queries: string[]
  mode: 'OR' | 'AND'
  perType: number
  types: GlobalSearchType[] | null
}

export interface GlobalSearchOperations {
  search(ownerId: string, query: GlobalSearchQuery): Promise<unknown>
}

export interface GlobalSearchRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: GlobalSearchOperations
}

function queryValues(value: unknown): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  throw new CoreError('invalid_request', '搜索关键词无效')
}

function singleQuery(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new CoreError('invalid_request', '搜索参数无效')
  return value
}

export function normalizeGlobalSearchQueries(q: string, queries: string[]): string[] {
  const input = queries.length > 0 ? queries : [q]
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of input) {
    const normalized = value.trim().slice(0, 64)
    const key = normalized.toLowerCase()
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
    if (result.length >= 8) break
  }
  return result
}

export function parseGlobalSearchQuery(value: unknown): GlobalSearchQuery {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const q = singleQuery(raw.q, '')
  const queries = normalizeGlobalSearchQueries(q, queryValues(raw.queries))
  const requestedMode = singleQuery(raw.mode, 'OR').toUpperCase()
  const mode = requestedMode === 'AND' ? 'AND' : 'OR'

  let perType = 6
  if (raw.per_type !== undefined) {
    const rawLimit = singleQuery(raw.per_type, '').trim()
    if (!/^[+-]?\d+$/.test(rawLimit)) throw new CoreError('invalid_request', 'per_type 必须是 1 到 200 之间的整数')
    perType = Number(rawLimit)
    if (!Number.isSafeInteger(perType) || perType < 1 || perType > 200)
      throw new CoreError('invalid_request', 'per_type 必须是 1 到 200 之间的整数')
  }

  const rawTypes = queryValues(raw.types)
  const known = new Set<string>(GLOBAL_SEARCH_TYPES)
  const types = rawTypes.length === 0 ? null : rawTypes.filter((type): type is GlobalSearchType => known.has(type))

  return { q, queries, mode, perType, types }
}

export function registerGlobalSearchRoute(app: FastifyInstance, options: GlobalSearchRouteOptions): void {
  app.get('/api/v1/search', { preHandler: options.requireUser }, async (request) =>
    options.operations.search(
      options.ownerIdFromRequest(request),
      parseGlobalSearchQuery(request.query),
    ))
}
