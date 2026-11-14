import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { toUtcIsoWithOffset } from '../../shared/date-time.js'
import { parsePythonInteger } from '../../http/request.js'

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

/** 读取与 Python Mind API 一致的活动 note 时间流，查询始终绑定可信 owner。 */
export function createPostgresMindNoteReader(pool: Pick<Pool, 'query'>): MindNoteReadOperations {
  return {
    async list(ownerId, limit, offset) {
      const result = await pool.query<MindNoteRow>(
        `SELECT id, kind, title, content_md, color, captured_at, version,
                created_at, updated_at, deleted_at, ref_type, ref_id, ref_snapshot
         FROM mind_nodes
         WHERE user_id = $1 AND kind = 'note' AND deleted_at IS NULL
         ORDER BY date(captured_at) DESC, created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [ownerId, limit, offset],
      )
      return result.rows.map(toMindNoteReadResponse)
    },

    async get(ownerId, noteId) {
      const result = await pool.query<MindNoteRow>(
        `SELECT id, kind, title, content_md, color, captured_at, version,
                created_at, updated_at, deleted_at, ref_type, ref_id, ref_snapshot
         FROM mind_nodes
         WHERE id = $1 AND user_id = $2 AND kind = 'note' AND deleted_at IS NULL
         LIMIT 1`,
        [noteId, ownerId],
      )
      const row = result.rows[0]
      return row ? toMindNoteReadResponse(row) : null
    },
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
