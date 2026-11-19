import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { PoolClient } from 'pg'

export interface FileDeleteReceipt {
  operationId: string
  fingerprint: string
  method: 'agent.file.delete_file'
}

export interface FileDeleteAgentResult {
  result: Record<string, unknown>
  replayed: boolean
}

export interface FileDeleteAgentOperation {
  receipt: FileDeleteReceipt
  signal: AbortSignal
  authorize(client: Pick<PoolClient, 'query'>): Promise<void>
}

export interface FileDeleteOperations {
  remove(ownerId: string, fileId: number, undoContextId: string | null, clientId: string | null,
    operation?: FileDeleteAgentOperation): Promise<void | FileDeleteAgentResult | { kind: 'unknown' }>
  removeMany?(ownerId: string, fileIds: number[], undoContextId: string | null, clientId: string | null,
    operation?: FileDeleteAgentOperation): Promise<void | FileDeleteAgentResult | { kind: 'unknown' }>
}

export interface FileDeleteRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileDeleteOperations
}

function fileId(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', '文件 ID 无效')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', '文件 ID 无效')
  return parsed
}

function requestHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name]
  return typeof value === 'string' ? value.trim().slice(0, 128) || null : null
}

export function registerFileDeleteRoutes(app: FastifyInstance, options: FileDeleteRouteOptions): void {
  app.delete<{ Params: { fid: string } }>('/api/v1/files/:fid', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    await options.operations.remove(
      options.ownerIdFromRequest(request),
      fileId(request.params.fid),
      requestHeader(request, 'x-undo-context-id'),
      requestHeader(request, 'x-client-id'),
    )
    return reply.code(204).send()
  })
  if (options.operations.removeMany) {
    app.post('/api/v1/files/batch-delete', { preHandler: options.requireUser }, async (request, reply) => {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new CoreError('invalid_request', '批量删除参数无效')
      const ids = (body as Record<string, unknown>).ids
      if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id)))
        throw new CoreError('invalid_request', '文件 ID 列表无效')
      await options.operations.removeMany!(
        options.ownerIdFromRequest(request),
        ids as number[],
        requestHeader(request, 'x-undo-context-id'),
        requestHeader(request, 'x-client-id'),
      )
      return reply.code(204).send()
    })
  }
}
