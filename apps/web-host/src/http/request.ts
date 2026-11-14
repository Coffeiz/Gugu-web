import type { FastifyRequest } from 'fastify'
import type { WriteRequestMetadata } from '../app.js'

export function writeRequestMetadata(
  request: FastifyRequest,
  options: { limitHeaders?: boolean } = {},
): WriteRequestMetadata {
  const header = (name: string) => {
    const value = request.headers[name]
    if (typeof value !== 'string') return null
    if (!options.limitHeaders) return value
    return value.trim().slice(0, 128) || null
  }
  return {
    idempotencyKey: header('idempotency-key'),
    undoContextId: header('x-undo-context-id'),
    clientId: header('x-client-id'),
  }
}

export function queryBoolean(query: Record<string, unknown>, key: string): boolean | undefined {
  const value = query[key]
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  return undefined
}

export function queryInteger(query: Record<string, unknown>, key: string): number | null | undefined {
  const value = query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null
  const result = Number(value)
  return Number.isSafeInteger(result) ? result : null
}

/** 对齐 Python int 字段的字符串转换；未提供字段保留 undefined，非法值返回 null。 */
export function parsePythonInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) ? parsed : null
}
