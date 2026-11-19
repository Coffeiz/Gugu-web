import type { FastifyInstance, FastifyRequest } from 'fastify'
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

export interface MindCanvasReadOperations {
  listCanvases(ownerId: string, projectId: number | null): Promise<MindCanvasResponse[]>
  listItems(ownerId: string, canvasId: number): Promise<MindCanvasItemResponse[] | null>
  listRelations(ownerId: string, canvasId: number): Promise<MindRelationResponse[] | null>
  canvasLocation(ownerId: string, nodeId: number): Promise<number | null>
}

export type MindCanvasOwnerFromRequest = (request: FastifyRequest) => string

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
