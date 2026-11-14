import { CoreError } from '@gugu/core'
import type { FileHandle } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface FileContentSource {
  file: unknown
  handle: FileHandle
  size: number
  fileName: string
  mimeType: string
}

export interface FileReadOperations {
  getFile(ownerId: string, fileId: number): Promise<unknown | null>
  getFileLocation(ownerId: string, fileId: number): Promise<unknown | null>
  getSummary(ownerId: string, recentLimit: number): Promise<unknown>
  getLibraryCounts(ownerId: string): Promise<unknown>
  getStorage(ownerId: string): Promise<unknown>
  openContent(ownerId: string, fileId: number): Promise<FileContentSource | null>
  resolveRelativePaths?(ownerId: string, fileId: number, paths: string[]): Promise<unknown[] | null>
}

export interface FileReadRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileReadOperations
}

function pathInteger(value: string): number {
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) throw new CoreError('invalid_request', '文件 ID 无效')
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', '文件 ID 无效')
  return parsed
}

function recentLimit(request: FastifyRequest): number {
  const raw = (request.query as Record<string, unknown>).recent_limit
  if (raw === undefined) return 12
  if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw.trim()))
    throw new CoreError('invalid_request', 'recent_limit 无效')
  const limit = Number(raw.trim())
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30)
    throw new CoreError('invalid_request', 'recent_limit 必须在 1 到 30 之间')
  return limit
}

function pathSegments(path: string): string[] {
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { return [] }
  const logicalPath = decoded.split(/[?#]/, 1)[0] ?? ''
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decoded) || decoded.startsWith('//')
    || logicalPath.startsWith('/') || logicalPath.startsWith('\\')
    || logicalPath.includes('\\') || logicalPath.includes('\0')) return []
  return logicalPath.split('/').filter((part) => part !== '' && part !== '.')
}

function resolvePathsBody(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError('invalid_request', '路径解析参数无效')
  const paths = (value as Record<string, unknown>).paths
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100
    || paths.some((item) => typeof item !== 'string' || !item || item.length > 1000))
    throw new CoreError('invalid_request', '路径解析列表无效')
  const pathList = paths as string[]
  const parts = pathList.map(pathSegments)
  if (parts.some((item) => item.length > 64) || parts.reduce((sum, item) => sum + item.length, 0) > 256)
    throw new CoreError('invalid_request', '批量路径最多解析 256 个片段，单条路径最多 64 个片段')
  return pathList
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (value === undefined) return { start: 0, end: Math.max(0, size - 1) }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || size === 0 || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return null
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || requestedEnd < start || start >= size) return null
  return { start, end: Math.min(size - 1, requestedEnd) }
}

function encodedFileName(fileName: string): string {
  return encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function dispositionHeader(disposition: 'inline' | 'attachment', fileName: string): string {
  return disposition === 'inline'
    ? 'inline'
    : `attachment; filename*=UTF-8''${encodedFileName(fileName)}`
}

async function sendContent(
  reply: FastifyReply,
  request: FastifyRequest,
  source: FileContentSource,
  disposition: 'inline' | 'attachment',
) {
  if (source.size === 0 && request.headers.range === undefined) {
    reply
      .code(200)
      .type(source.mimeType || 'application/octet-stream')
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', '0')
      .header('Content-Disposition', dispositionHeader(disposition, source.fileName))
      .header('Cache-Control', 'private, max-age=300')
    return reply.send(source.handle.createReadStream({ autoClose: true }))
  }
  const range = parseRange(request.headers.range, source.size)
  if (!range) {
    await source.handle.close()
    return reply.code(416).header('Content-Range', `bytes */${source.size}`).send()
  }
  const partial = request.headers.range !== undefined
  const length = range.end - range.start + 1
  reply
    .code(partial ? 206 : 200)
    .type(source.mimeType || 'application/octet-stream')
    .header('Accept-Ranges', 'bytes')
    .header('Content-Length', String(length))
    .header('Content-Disposition', dispositionHeader(disposition, source.fileName))
    .header('Cache-Control', 'private, max-age=300')
  if (partial) reply.header('Content-Range', `bytes ${range.start}-${range.end}/${source.size}`)
  return reply.send(source.handle.createReadStream({ start: range.start, end: range.end, autoClose: true }))
}

export function registerFileReadRoutes(app: FastifyInstance, options: FileReadRouteOptions): void {
  app.get('/api/v1/files/summary', { preHandler: options.requireUser }, async (request) =>
    options.operations.getSummary(options.ownerIdFromRequest(request), recentLimit(request)))
  app.get('/api/v1/files/library-counts', { preHandler: options.requireUser }, async (request) =>
    options.operations.getLibraryCounts(options.ownerIdFromRequest(request)))
  app.get('/api/v1/files/storage', { preHandler: options.requireUser }, async (request) =>
    options.operations.getStorage(options.ownerIdFromRequest(request)))

  if (options.operations.resolveRelativePaths) {
    app.post<{ Params: { fid: string } }>('/api/v1/files/:fid/resolve-paths', {
      preHandler: options.requireUser,
    }, async (request) => {
      const resolved = await options.operations.resolveRelativePaths!(
        options.ownerIdFromRequest(request), pathInteger(request.params.fid), resolvePathsBody(request.body),
      )
      if (resolved === null) throw new CoreError('not_found', '来源文件不存在')
      return resolved
    })
  }

  app.get<{ Params: { fid: string } }>('/api/v1/files/:fid/stream-url', { preHandler: options.requireUser }, async (request) => {
    const fileId = pathInteger(request.params.fid)
    const file = await options.operations.getFile(options.ownerIdFromRequest(request), fileId)
    if (file === null) throw new CoreError('not_found', '文件不存在')
    return { file, url: `/api/v1/files/${fileId}/stream` }
  })
  for (const [suffix, disposition] of [['download', 'attachment'], ['stream', 'inline']] as const) {
    app.get<{ Params: { fid: string } }>(`/api/v1/files/:fid/${suffix}`, {
      preHandler: options.requireUser,
    }, async (request, reply) => {
      const source = await options.operations.openContent(
        options.ownerIdFromRequest(request), pathInteger(request.params.fid),
      )
      if (!source) throw new CoreError('not_found', '文件不存在')
      return sendContent(reply, request, source, disposition)
    })
  }

  app.get<{ Params: { fid: string } }>('/api/v1/files/:fid/location', { preHandler: options.requireUser }, async (request) => {
    const result = await options.operations.getFileLocation(
      options.ownerIdFromRequest(request), pathInteger(request.params.fid),
    )
    if (result === null) throw new CoreError('not_found', '文件不存在')
    return result
  })
  app.get<{ Params: { fid: string } }>('/api/v1/files/:fid', { preHandler: options.requireUser }, async (request) => {
    const result = await options.operations.getFile(
      options.ownerIdFromRequest(request), pathInteger(request.params.fid),
    )
    if (result === null) throw new CoreError('not_found', '文件不存在')
    return result
  })
}
