import type { FastifyInstance, FastifyRequest } from 'fastify'
import { parsePythonInteger, writeRequestMetadata } from '../../http/request.js'
import type { MindNoteReadResponse } from './notes.js'
import type { UserFromRequest, WriteRequestMetadata } from '../../app.js'
import { MindCanvasMutationError } from '@gugu/core/mind'

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

export interface MindCanvasMutationOptions {
  create(ownerId: string, input: unknown, metadata: WriteRequestMetadata): Promise<MindCanvasResponse>
  update(ownerId: string, canvasId: number, input: unknown, metadata: WriteRequestMetadata): Promise<MindCanvasResponse>
  delete?(ownerId: string, canvasId: number, metadata: WriteRequestMetadata): Promise<void>
}

export function registerMindCanvasMutationRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: MindCanvasMutationOptions,
): void {
  app.post('/api/v1/mind/canvases', async (request, reply) => {
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      const canvas = await options.create(ownerId, request.body, writeRequestMetadata(request))
      return reply.code(201).send(canvas)
    } catch (error) {
      if (error instanceof MindCanvasMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })

  app.patch<{ Params: { canvasId: string } }>('/api/v1/mind/canvases/:canvasId', async (request, reply) => {
    const canvasId = parsePythonInteger(request.params.canvasId)
    if (typeof canvasId !== 'number')
      return reply.code(422).send({ detail: '画布标识无效' })
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      return await options.update(ownerId, canvasId, request.body, writeRequestMetadata(request))
    } catch (error) {
      if (error instanceof MindCanvasMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })

  if (options.delete) app.delete<{ Params: { canvasId: string } }>('/api/v1/mind/canvases/:canvasId', async (request, reply) => {
    const canvasId = parsePythonInteger(request.params.canvasId)
    if (typeof canvasId !== 'number')
      return reply.code(422).send({ detail: '画布标识无效' })
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    try {
      await options.delete!(ownerId, canvasId, writeRequestMetadata(request))
      return reply.code(204).send()
    } catch (error) {
      if (error instanceof MindCanvasMutationError)
        return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}
