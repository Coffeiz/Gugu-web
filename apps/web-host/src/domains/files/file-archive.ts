import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { WriteRequestMetadata } from '../../app.js'
import { writeRequestMetadata } from '../../http/request.js'

export interface FileArchiveInput {
  fileIds: number[]
  folderIds: number[]
  /** undefined means use the source folder; null means the personal root. */
  folderId?: number | null
  name?: string
}

export interface FileUnarchiveInput {
  fileId: number
  /** undefined means use the archive folder; null means the personal root. */
  folderId?: number | null
  folderName?: string
  format?: string
}

export interface FileArchiveOperations {
  archive(ownerId: string, input: FileArchiveInput, metadata: WriteRequestMetadata): Promise<unknown>
  unarchive(ownerId: string, input: FileUnarchiveInput, metadata: WriteRequestMetadata): Promise<unknown>
}

export interface FileArchiveRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileArchiveOperations
}

function statusForArchiveError(error: CoreError): number | null {
  if (error.code === 'invalid_request') return 400
  if (error.code === 'not_found') return 404
  if (error.code === 'conflict') return 409
  if (error.code === 'busy') return 503
  return null
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError('invalid_request', message)
  return value as Record<string, unknown>
}

function positiveId(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new CoreError('invalid_request', `${field} 无效`)
  return Number(value)
}

function optionalFolderId(body: Record<string, unknown>): number | null | undefined {
  const field = Object.hasOwn(body, 'folderId') ? 'folderId' : 'folder_id'
  if (!Object.hasOwn(body, field)) return undefined
  return body[field] === null ? null : positiveId(body[field], 'folderId')
}

function field(body: Record<string, unknown>, camel: string, snake: string): unknown {
  return Object.hasOwn(body, camel) ? body[camel] : body[snake]
}

function idList(value: unknown, field: string): number[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new CoreError('invalid_request', `${field} 无效`)
  return value.map((id) => positiveId(id, field))
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new CoreError('invalid_request', `${field} 无效`)
  return value
}

export function registerFileArchiveRoutes(app: FastifyInstance, options: FileArchiveRouteOptions): void {
  app.post('/api/v1/files/archive', { preHandler: options.requireUser }, async (request, reply) => {
    const body = record(request.body, '压缩参数无效')
    const input: FileArchiveInput = {
      fileIds: idList(field(body, 'fileIds', 'file_ids'), 'fileIds'),
      folderIds: idList(field(body, 'folderIds', 'folder_ids'), 'folderIds'),
      folderId: optionalFolderId(body),
      name: optionalString(body.name, 'name'),
    }
    try {
      const result = await options.operations.archive(
        options.ownerIdFromRequest(request), input, writeRequestMetadata(request, { limitHeaders: true }))
      return reply.code(201).send(result)
    } catch (error) {
      if (error instanceof CoreError) {
        const status = statusForArchiveError(error)
        if (status !== null) return reply.code(status).send({ detail: error.message })
      }
      throw error
    }
  })

  app.post('/api/v1/files/unarchive', { preHandler: options.requireUser }, async (request, reply) => {
    const body = record(request.body, '解压参数无效')
    const input: FileUnarchiveInput = {
      fileId: positiveId(field(body, 'fileId', 'file_id'), 'fileId'),
      folderId: optionalFolderId(body),
      folderName: optionalString(field(body, 'folderName', 'folder_name'), 'folderName'),
      format: optionalString(body.format, 'format'),
    }
    try {
      return await options.operations.unarchive(
        options.ownerIdFromRequest(request), input, writeRequestMetadata(request, { limitHeaders: true }))
    } catch (error) {
      if (error instanceof CoreError) {
        const status = statusForArchiveError(error)
        if (status !== null) return reply.code(status).send({ detail: error.message })
      }
      throw error
    }
  })
}
