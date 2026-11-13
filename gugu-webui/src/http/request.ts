import type { FastifyRequest } from 'fastify'
import type { WriteRequestMetadata } from '../app.js'

export function writeRequestMetadata(request: FastifyRequest): WriteRequestMetadata {
  const header = (name: string) => {
    const value = request.headers[name]
    return typeof value === 'string' ? value : null
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
