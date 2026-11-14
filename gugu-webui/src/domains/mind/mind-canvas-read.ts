import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { toUtcIsoWithOffset } from '../../shared/date-time.js'
import { parsePythonInteger } from '../../http/request.js'
import type { MindNoteReadResponse } from './mind-notes-read.js'

export interface MindCanvasResponse {
  id: number
  title: string
  projectId: number | null
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface MindCanvasItemResponse {
  id: number
  canvasId: number
  nodeId: number
  x: number
  y: number
  w: number | null
  h: number | null
  z: number
  collapsed: boolean
  data: Record<string, unknown>
  refData: { date: string; time: string | null; endTime: string | null; description: string | null } | null
  node: MindNoteReadResponse
  createdAt: string
  updatedAt: string
}

export interface MindRelationResponse {
  id: number
  canvasId: number | null
  srcNodeId: number
  dstNodeId: number
  relType: string
  origin: string
  status: string
  createdAt: string
  updatedAt: string
}

type Row = Record<string, unknown> & {
  id: number | string
  created_at: Date | string
  updated_at: Date | string
}

export interface MindCanvasReadOperations {
  listCanvases(ownerId: string, projectId: number | null): Promise<MindCanvasResponse[]>
  listItems(ownerId: string, canvasId: number): Promise<MindCanvasItemResponse[] | null>
  listRelations(ownerId: string, canvasId: number): Promise<MindRelationResponse[] | null>
  canvasLocation(ownerId: string, nodeId: number): Promise<number | null>
}

export type MindCanvasOwnerFromRequest = (request: FastifyRequest) => string

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value || '{}')
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function number(value: unknown): number {
  return Number(value)
}

function date(value: Date | string): string {
  return toUtcIsoWithOffset(value)
}

function mapCanvas(row: Row): MindCanvasResponse {
  return {
    id: number(row.id),
    title: String(row.title ?? ''),
    projectId: row.project_id === null || row.project_id === undefined ? null : number(row.project_id),
    data: parseObject(row.data_json),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
}

function mapNode(row: Row): MindNoteReadResponse {
  return {
    id: number(row.node_id),
    kind: String(row.kind ?? ''),
    title: row.node_title === null || row.node_title === undefined ? null : String(row.node_title),
    contentMd: String(row.content_md ?? ''),
    color: row.color === null || row.color === undefined ? null : String(row.color),
    capturedAt: date(row.captured_at as Date | string),
    version: number(row.version),
    createdAt: date(row.node_created_at as Date | string),
    updatedAt: date(row.node_updated_at as Date | string),
    deletedAt: row.node_deleted_at === null || row.node_deleted_at === undefined ? null : date(row.node_deleted_at as Date | string),
    refType: row.ref_type === null || row.ref_type === undefined ? null : String(row.ref_type),
    refId: row.ref_id === null || row.ref_id === undefined ? null : number(row.ref_id),
    refSnapshot: row.ref_snapshot === null || row.ref_snapshot === undefined ? null : parseObject(row.ref_snapshot),
  }
}

function mapRelation(row: Row): MindRelationResponse {
  return {
    id: number(row.id),
    canvasId: row.canvas_id === null || row.canvas_id === undefined ? null : number(row.canvas_id),
    srcNodeId: number(row.src_node_id),
    dstNodeId: number(row.dst_node_id),
    relType: String(row.rel_type),
    origin: String(row.origin),
    status: String(row.status),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
}

/** Canvas reads mirror Python's active-row filters and always bind the verified owner. */
export function createPostgresMindCanvasReader(pool: Pick<Pool, 'query'>): MindCanvasReadOperations {
  async function ownsCanvas(ownerId: string, canvasId: number): Promise<boolean> {
    const result = await pool.query(
      'SELECT 1 FROM mind_maps WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL LIMIT 1',
      [canvasId, ownerId],
    )
    return result.rows.length > 0
  }

  return {
    async listCanvases(ownerId, projectId) {
      const values: unknown[] = [ownerId]
      let projectFilter = ''
      if (projectId !== null) {
        values.push(projectId)
        projectFilter = ' AND project_id=$2'
      }
      const result = await pool.query<Row>(
        `SELECT id, title, project_id, data_json, created_at, updated_at
         FROM mind_maps
         WHERE user_id=$1 AND deleted_at IS NULL${projectFilter}
         ORDER BY updated_at DESC, id DESC
         LIMIT 200`,
        values,
      )
      return result.rows.map(mapCanvas)
    },

    async listItems(ownerId, canvasId) {
      if (!await ownsCanvas(ownerId, canvasId)) return null
      const result = await pool.query<Row>(
        `SELECT ci.id, ci.canvas_id, ci.node_id, ci.x, ci.y, ci.w, ci.h, ci.z, ci.collapsed,
                ci.data_json AS item_data_json, ci.created_at AS item_created_at, ci.updated_at AS item_updated_at,
                n.kind, n.title AS node_title, n.content_md, n.color, n.captured_at, n.version,
                n.created_at AS node_created_at, n.updated_at AS node_updated_at, n.deleted_at AS node_deleted_at,
                n.ref_type, n.ref_id, n.ref_snapshot
         FROM mind_canvas_items ci
         JOIN mind_nodes n ON n.id=ci.node_id
         WHERE ci.canvas_id=$1 AND ci.user_id=$2 AND ci.deleted_at IS NULL
           AND n.user_id=$2 AND n.deleted_at IS NULL
         ORDER BY ci.z, ci.id`,
        [canvasId, ownerId],
      )
      const eventIds = [...new Set(result.rows
        .filter((row) => row.ref_type === 'event' && row.ref_id !== null && row.ref_id !== undefined)
        .map((row) => number(row.ref_id)))]
      const eventData = new Map<number, MindCanvasItemResponse['refData']>()
      if (eventIds.length) {
        const events = await pool.query<Row>(
          `SELECT id, date, time, end_time, description FROM calendar_events
           WHERE user_id=$1 AND deleted_at IS NULL AND id=ANY($2::bigint[])`,
          [ownerId, eventIds],
        )
        for (const event of events.rows) {
          eventData.set(number(event.id), {
            date: String(event.date),
            time: event.time === null || event.time === undefined ? null : String(event.time),
            endTime: event.end_time === null || event.end_time === undefined ? null : String(event.end_time),
            description: event.description === null || event.description === undefined ? null : String(event.description),
          })
        }
      }
      return result.rows.map((row) => ({
        id: number(row.id),
        canvasId: number(row.canvas_id),
        nodeId: number(row.node_id),
        x: number(row.x),
        y: number(row.y),
        w: row.w === null || row.w === undefined ? null : number(row.w),
        h: row.h === null || row.h === undefined ? null : number(row.h),
        z: number(row.z),
        collapsed: Boolean(row.collapsed),
        data: parseObject(row.item_data_json),
        refData: row.ref_type === 'event' && row.ref_id !== null && row.ref_id !== undefined
          ? eventData.get(number(row.ref_id)) ?? null
          : null,
        node: mapNode(row),
        createdAt: date(row.item_created_at as Date | string),
        updatedAt: date(row.item_updated_at as Date | string),
      }))
    },

    async listRelations(ownerId, canvasId) {
      const canvasResult = await pool.query<Row>(
        'SELECT data_json FROM mind_maps WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL LIMIT 1',
        [canvasId, ownerId],
      )
      const canvas = canvasResult.rows[0]
      if (!canvas) return null
      const detachedRaw = parseObject(canvas.data_json).detachedRelationIds
      const detached = new Set(Array.isArray(detachedRaw)
        ? detachedRaw.filter((value): value is number => Number.isSafeInteger(value))
        : [])
      const result = await pool.query<Row>(
        `SELECT r.id, r.canvas_id, r.src_node_id, r.dst_node_id, r.rel_type, r.origin, r.status,
                r.created_at, r.updated_at
         FROM mind_relations r
         WHERE r.user_id=$2 AND r.canvas_id=$1 AND r.deleted_at IS NULL
           AND r.src_node_id IN (SELECT node_id FROM mind_canvas_items WHERE canvas_id=$1 AND user_id=$2)
           AND r.dst_node_id IN (SELECT node_id FROM mind_canvas_items WHERE canvas_id=$1 AND user_id=$2)
         ORDER BY r.id`,
        [canvasId, ownerId],
      )
      return result.rows.filter((row) => !detached.has(number(row.id))).map(mapRelation)
    },

    async canvasLocation(ownerId, nodeId) {
      const result = await pool.query<{ canvas_id: number | string }>(
        `SELECT ci.canvas_id
         FROM mind_canvas_items ci
         JOIN mind_nodes n ON n.id=ci.node_id
         JOIN mind_maps mm ON mm.id=ci.canvas_id
         WHERE n.id=$1 AND n.user_id=$2 AND n.kind='canvas_note' AND n.deleted_at IS NULL
           AND ci.user_id=$2 AND ci.deleted_at IS NULL
           AND mm.user_id=$2 AND mm.deleted_at IS NULL
         LIMIT 1`,
        [nodeId, ownerId],
      )
      const row = result.rows[0]
      return row ? number(row.canvas_id) : null
    },
  }
}

export function registerMindCanvasReadRoutes(
  app: FastifyInstance,
  ownerFromRequest: MindCanvasOwnerFromRequest,
  operations: MindCanvasReadOperations,
): void {
  app.get('/api/v1/mind/canvases', async (request, reply) => {
    const raw = (request.query as Record<string, unknown>).project_id
    const projectId = raw === undefined ? null : parsePythonInteger(raw)
    if (raw !== undefined && typeof projectId !== 'number') return reply.code(422).send({ detail: '项目标识无效' })
    return operations.listCanvases(ownerFromRequest(request), projectId ?? null)
  })

  app.get<{ Params: { canvasId: string } }>('/api/v1/mind/canvases/:canvasId/items', async (request, reply) => {
    const canvasId = parsePythonInteger(request.params.canvasId)
    if (typeof canvasId !== 'number') return reply.code(422).send({ detail: '画布标识无效' })
    const rows = await operations.listItems(ownerFromRequest(request), canvasId)
    if (rows === null) return reply.code(404).send({ detail: '画布不存在' })
    return rows
  })

  app.get<{ Params: { canvasId: string } }>('/api/v1/mind/canvases/:canvasId/relations', async (request, reply) => {
    const canvasId = parsePythonInteger(request.params.canvasId)
    if (typeof canvasId !== 'number') return reply.code(422).send({ detail: '画布标识无效' })
    const rows = await operations.listRelations(ownerFromRequest(request), canvasId)
    if (rows === null) return reply.code(404).send({ detail: '画布不存在' })
    return rows
  })

  app.get<{ Params: { nodeId: string } }>('/api/v1/mind/nodes/:nodeId/canvas-location', async (request, reply) => {
    const nodeId = parsePythonInteger(request.params.nodeId)
    if (typeof nodeId !== 'number') return reply.code(422).send({ detail: '节点标识无效' })
    const canvasId = await operations.canvasLocation(ownerFromRequest(request), nodeId)
    if (canvasId === null) return reply.code(404).send({ detail: '画布便签不存在' })
    return { canvasId }
  })
}
