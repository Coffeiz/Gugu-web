import type { FastifyInstance, FastifyRequest } from 'fastify'
import { toUtcIsoWithOffset } from '../../shared/date-time.js'
import { parsePythonInteger, writeRequestMetadata } from '../../http/request.js'
import type { UserFromRequest, WriteRequestMetadata } from '../../app.js'
import { MindNoteCreateError, MindNoteMutationError } from '@gugu/core/mind'

export interface MindNoteReadResponse {
  id: number
  kind: string
  title: string | null
  contentMd: string
  color: string | null
  capturedAt: string
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  refType: string | null
  refId: number | null
  refSnapshot: Record<string, unknown> | null
}

export type MindNoteRow = {
  id: number | string
  kind: string
  title: string | null
  content_md: string | null
  color: string | null
  captured_at: Date | string
  version: number | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
  ref_type: string | null
  ref_id: number | string | null
  ref_snapshot: Record<string, unknown> | null
}

export interface MindNoteReadOperations {
  list(ownerId: string, limit: number, offset: number): Promise<MindNoteReadResponse[]>
  get(ownerId: string, noteId: number): Promise<MindNoteReadResponse | null>
}

export type MindNoteOwnerFromRequest = (request: FastifyRequest) => string

export function toMindNoteReadResponse(row: MindNoteRow): MindNoteReadResponse {
  return {
    id: Number(row.id),
    kind: row.kind,
    title: row.title,
    contentMd: row.content_md ?? '',
    color: row.color,
    capturedAt: toUtcIsoWithOffset(row.captured_at),
    version: Number(row.version),
    createdAt: toUtcIsoWithOffset(row.created_at),
    updatedAt: toUtcIsoWithOffset(row.updated_at),
    deletedAt: row.deleted_at === null ? null : toUtcIsoWithOffset(row.deleted_at),
    refType: row.ref_type,
    refId: row.ref_id === null ? null : Number(row.ref_id),
    refSnapshot: row.ref_snapshot,
  }
}

/** 只注册在已认证域内；owner 由 Host 从已验证 RequestContext 提供。 */
export function registerMindNoteReadRoutes(
  app: FastifyInstance,
  ownerFromRequest: MindNoteOwnerFromRequest,
  operations: MindNoteReadOperations,
): void {
  app.get('/api/v1/mind/notes', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const limit = query.limit === undefined ? 50 : parsePythonInteger(query.limit) ?? null
    const offset = query.offset === undefined ? 0 : parsePythonInteger(query.offset) ?? null
    if (limit === null || limit < 1 || limit > 200 || offset === null || offset < 0)
      return reply.code(422).send({ detail: '分页参数无效' })
    return operations.list(ownerFromRequest(request), limit, offset)
  })

  app.get<{ Params: { noteId: string } }>('/api/v1/mind/notes/:noteId', async (request, reply) => {
    const noteId = parsePythonInteger(request.params.noteId) ?? null
    if (noteId === null) return reply.code(422).send({ detail: '便签标识无效' })
    const note = await operations.get(ownerFromRequest(request), noteId)
    if (note === null) return reply.code(404).send({ detail: '便签不存在' })
    return note
  })
}

export interface MindNoteCreateOptions {
  create(
    ownerId: string,
    input: unknown,
    metadata: WriteRequestMetadata & { mutationId?: string | null },
  ): Promise<MindNoteReadResponse>
}

export function registerMindNoteCreateRoute(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindNoteCreateOptions,
): void {
  app.post('/api/v1/mind/notes', async (request, reply) => {
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      const mutationId = request.headers['x-mutation-id']
      const note = await options.create(ownerId, request.body, {
        ...writeRequestMetadata(request),
        mutationId: typeof mutationId === 'string' ? mutationId : null,
      })
      return reply.code(201).send(note)
    } catch (error) {
      if (error instanceof MindNoteCreateError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}

export interface MindNoteMutationOptions {
  update(
    ownerId: string,
    noteId: number,
    input: unknown,
    metadata: WriteRequestMetadata & { mutationId?: string | null },
  ): Promise<MindNoteReadResponse>
  delete(ownerId: string, noteId: number, metadata: WriteRequestMetadata & { mutationId?: string | null }): Promise<void>
}

export function registerMindNoteMutationRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindNoteMutationOptions,
): void {
  app.patch<{ Params: { noteId: string } }>('/api/v1/mind/notes/:noteId', async (request, reply) => {
    const id = parsePythonInteger(request.params.noteId) ?? null
    if (id === null) return reply.code(422).send({ detail: '便签标识无效' })
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      const mutationId = request.headers['x-mutation-id']
      return await options.update(ownerId, id, request.body, {
        ...writeRequestMetadata(request),
        mutationId: typeof mutationId === 'string' ? mutationId : null,
      })
    } catch (error) {
      if (error instanceof MindNoteMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })

  app.delete<{ Params: { noteId: string } }>('/api/v1/mind/notes/:noteId', async (request, reply) => {
    const id = parsePythonInteger(request.params.noteId) ?? null
    if (id === null) return reply.code(422).send({ detail: '便签标识无效' })
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      const mutationId = request.headers['x-mutation-id']
      await options.delete(ownerId, id, {
        ...writeRequestMetadata(request),
        mutationId: typeof mutationId === 'string' ? mutationId : null,
      })
      return reply.code(204).send()
    } catch (error) {
      if (error instanceof MindNoteMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}
