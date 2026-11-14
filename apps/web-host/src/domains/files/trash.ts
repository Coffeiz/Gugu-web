import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface TrashOperations {
  listFiles(ownerId: string, query: { limit: number; cursor: string | null }): Promise<TrashPage<Record<string, unknown>>>
  listFolders(ownerId: string, query: { limit: number; cursor: string | null }): Promise<TrashPage<Record<string, unknown>>>
  listFolderContents(ownerId: string, folderId: number, query: {
    limit: number
    folderCursor: string | null
    fileCursor: string | null
  }): Promise<{
    folders: TrashPage<Record<string, unknown>>
    files: TrashPage<Record<string, unknown>>
  } | null>
  restoreFolder(ownerId: string, folderId: number, origin: string | null): Promise<unknown>
  restoreFiles(ownerId: string, fileIds: number[], origin: string | null): Promise<void>
  hardDeleteFile(ownerId: string, fileId: number, origin: string | null): Promise<void>
  hardDeleteFolder(ownerId: string, folderId: number, origin: string | null): Promise<void>
  startEmpty(ownerId: string): Promise<TrashPurgeJob>
  activeEmpty(ownerId: string): Promise<TrashPurgeJob | null>
  getEmpty(ownerId: string, jobId: number): Promise<TrashPurgeJob | null>
}

export interface TrashPurgeJob {
  id: number
  status: 'queued' | 'running' | 'completed' | 'failed'
  progressCurrent: number
  progressTotal: number
  failedCount: number
  errorCode: string | null
}

export class TrashCooldownError extends Error {
  constructor() {
    super('刚完成清空，请稍后再试')
    this.name = 'TrashCooldownError'
  }
}

export interface TrashPage<T> {
  items: T[]
  has_more: boolean
  next_cursor: string | null
}

export interface TrashRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: TrashOperations
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim()))
    throw new CoreError('invalid_request', `${label} 无效`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CoreError('invalid_request', `${label} 无效`)
  return parsed
}

function queryText(request: FastifyRequest, name: string): string | null {
  const value = (request.query as Record<string, unknown>)[name]
  if (value === undefined) return null
  if (typeof value !== 'string') throw new CoreError('invalid_request', `${name} 无效`)
  return value
}

function pageLimit(request: FastifyRequest): number {
  const raw = queryText(request, 'limit')
  if (raw === null) return 100
  const limit = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new CoreError('invalid_request', 'limit 必须在 1 到 200 之间')
  return limit
}

function clientId(request: FastifyRequest): string | null {
  const value = request.headers['x-client-id']
  return typeof value === 'string' ? value.trim().slice(0, 128) || null : null
}

export function registerTrashRoutes(app: FastifyInstance, options: TrashRouteOptions): void {
  const owner = (request: FastifyRequest) => options.ownerIdFromRequest(request)
  app.get('/api/v1/trash/page', { preHandler: options.requireUser }, async (request) =>
    options.operations.listFiles(owner(request), { limit: pageLimit(request), cursor: queryText(request, 'cursor') }))

  app.get('/api/v1/trash/folders/page', { preHandler: options.requireUser }, async (request) =>
    options.operations.listFolders(owner(request), { limit: pageLimit(request), cursor: queryText(request, 'cursor') }))

  app.get<{ Params: { fid: string } }>('/api/v1/trash/folders/:fid/contents/page', {
    preHandler: options.requireUser,
  }, async (request) => {
    const result = await options.operations.listFolderContents(owner(request), parsePositiveInteger(request.params.fid, '文件夹 ID'), {
      limit: pageLimit(request),
      folderCursor: queryText(request, 'folder_cursor'),
      fileCursor: queryText(request, 'file_cursor'),
    })
    if (result === null) throw new CoreError('not_found', '文件夹不存在')
    return result
  })

  app.post<{ Params: { fid: string } }>('/api/v1/trash/folders/:fid/restore', {
    preHandler: options.requireUser,
  }, async (request) => options.operations.restoreFolder(
    owner(request), parsePositiveInteger(request.params.fid, '文件夹 ID'), clientId(request),
  ))

  app.post('/api/v1/trash/batch-restore', { preHandler: options.requireUser }, async (request, reply) => {
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Array.isArray((body as Record<string, unknown>).ids)
      || !((body as Record<string, unknown>).ids as unknown[]).every((id) =>
        typeof id === 'number' && Number.isSafeInteger(id) && id > 0))
      throw new CoreError('invalid_request', '文件 ID 列表无效')
    await options.operations.restoreFiles(owner(request), (body as { ids: number[] }).ids, clientId(request))
    return reply.code(204).send()
  })

  app.delete<{ Params: { fid: string } }>('/api/v1/trash/folders/:fid', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    await options.operations.hardDeleteFolder(owner(request), parsePositiveInteger(request.params.fid, '文件夹 ID'), clientId(request))
    return reply.code(204).send()
  })

  app.delete<{ Params: { fid: string } }>('/api/v1/trash/:fid', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    await options.operations.hardDeleteFile(owner(request), parsePositiveInteger(request.params.fid, '文件 ID'), clientId(request))
    return reply.code(204).send()
  })

  const startEmpty = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    try { return reply.code(202).send(await options.operations.startEmpty(owner(request))) }
    catch (error) {
      if (!(error instanceof TrashCooldownError)) throw error
      return reply.code(429).header('Retry-After', '30').send({ detail: error.message })
    }
  }
  app.post('/api/v1/trash/empty', { preHandler: options.requireUser }, startEmpty)

  app.get('/api/v1/trash/empty/active', { preHandler: options.requireUser }, async (request) =>
    options.operations.activeEmpty(owner(request)))

  app.get<{ Params: { job_id: string } }>('/api/v1/trash/empty/:job_id', {
    preHandler: options.requireUser,
  }, async (request) => {
    const result = await options.operations.getEmpty(owner(request), parsePositiveInteger(request.params.job_id, '任务 ID'))
    if (result === null) throw new CoreError('not_found', '清空任务不存在')
    return result
  })

  // 旧客户端使用 DELETE /trash；与 POST /trash/empty 共用同一条持久化队列。
  app.delete('/api/v1/trash', { preHandler: options.requireUser }, startEmpty)
}
