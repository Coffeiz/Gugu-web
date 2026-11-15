import { imageSize } from 'image-size'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { CoreError } from '@gugu/core'
import { planFileThumbnail } from '@gugu/core/files/read'
import type { FileReadOperations } from '../../domains/files/file-reads.js'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface FileThumbnailOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileReadOperations
}

type ThumbnailFile = { mimeType?: unknown; version?: unknown }
type RenderedThumbnail = { bytes: Buffer; mimeType: string }
type ThumbnailMetadata = { mimeType: string | null; version: number }

const THUMBNAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024
const THUMBNAIL_CACHE_MAX_ENTRIES = 128
const thumbnailCache = new Map<string, RenderedThumbnail>()
let thumbnailCacheBytes = 0

function parseFileId(value: string): number {
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) throw new CoreError('invalid_request', '文件 ID 无效')
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', '文件 ID 无效')
  return parsed
}

function fileMetadata(file: unknown): ThumbnailMetadata {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return { mimeType: null, version: 1 }
  const value = file as ThumbnailFile
  return {
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : null,
    version: typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > 0
      ? value.version
      : 1,
  }
}

function detectedFormat(raw: Buffer): string | null {
  try {
    const type = imageSize(raw).type
    return typeof type === 'string' ? type.toUpperCase() : null
  } catch { return null }
}

async function resizeThumbnail(raw: Buffer, maxDimension: number, quality: number): Promise<RenderedThumbnail> {
  const image = await loadImage(raw)
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0, width, height)
  try {
    return { bytes: canvas.toBuffer('image/webp', quality), mimeType: 'image/webp' }
  } catch {
    const fallbackCanvas = createCanvas(width, height)
    fallbackCanvas.getContext('2d').drawImage(image, 0, 0, width, height)
    try { return { bytes: fallbackCanvas.toBuffer('image/jpeg', 80), mimeType: 'image/jpeg' } }
    catch { return { bytes: raw, mimeType: 'application/octet-stream' } }
  }
}

function cacheThumbnail(key: string, result: RenderedThumbnail): void {
  if (result.bytes.byteLength > THUMBNAIL_CACHE_MAX_BYTES) return
  while (thumbnailCache.size >= THUMBNAIL_CACHE_MAX_ENTRIES
    || thumbnailCacheBytes + result.bytes.byteLength > THUMBNAIL_CACHE_MAX_BYTES) {
    const oldest = thumbnailCache.keys().next().value
    if (oldest === undefined) return
    const removed = thumbnailCache.get(oldest)
    if (removed) thumbnailCacheBytes -= removed.bytes.byteLength
    thumbnailCache.delete(oldest)
  }
  thumbnailCache.set(key, result)
  thumbnailCacheBytes += result.bytes.byteLength
}

/** Remove shared-cache entries belonging to the deleted owner's database file IDs. */
export function deleteOwnerThumbnailCache(ownerId: string, fileIds: readonly number[]): void {
  const ownedIds = new Set(fileIds)
  for (const [key, value] of thumbnailCache) {
    let identity: unknown
    try { identity = JSON.parse(key) } catch { continue }
    if (!Array.isArray(identity) || identity[0] !== ownerId || !ownedIds.has(identity[1])) continue
    thumbnailCache.delete(key)
    thumbnailCacheBytes -= value.bytes.byteLength
  }
}

async function createThumbnail(
  raw: Buffer,
  declaredMimeType: string | null,
  size: string,
): Promise<RenderedThumbnail> {
  const plan = planFileThumbnail(declaredMimeType, detectedFormat(raw), size)
  if (!plan) throw Object.assign(new Error('不是图片文件'), { statusCode: 415 })
  if (plan.kind === 'raw') return { bytes: raw, mimeType: plan.mimeType }
  try { return await resizeThumbnail(raw, plan.maxDimension, plan.quality) }
  catch { return { bytes: raw, mimeType: plan.mimeType } }
}

export function registerFileThumbnailRoute(app: FastifyInstance, options: FileThumbnailOptions): void {
  app.get<{ Params: { fid: string } }>('/api/v1/files/:fid/thumb', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    const fileId = parseFileId(request.params.fid)
    const file = await options.operations.getFile(ownerId, fileId)
    if (file === null) throw new CoreError('not_found', '文件不存在')
    const metadata = fileMetadata(file)
    const declaredMime = (metadata.mimeType ?? '').toLowerCase().trim()
    if (!['', 'application/octet-stream', 'binary/octet-stream'].includes(declaredMime)
      && !planFileThumbnail(declaredMime, null, 'full'))
      throw Object.assign(new Error('不是图片文件'), { statusCode: 415 })
    const source = await options.operations.openContent(ownerId, fileId)
    if (!source) throw new CoreError('not_found', '物理文件丢失')
    let raw: Buffer
    try { raw = await source.handle.readFile() }
    finally { await source.handle.close() }

    const querySize = (request.query as Record<string, unknown>).size
    const size = typeof querySize === 'string' ? querySize : 'full'
    const key = JSON.stringify([ownerId, fileId, metadata.version, size])
    const cached = size === 'full' ? undefined : thumbnailCache.get(key)
    const rendered = cached ?? await createThumbnail(raw, metadata.mimeType ?? source.mimeType, size)
    if (!cached && size !== 'full' && rendered.bytes !== raw) cacheThumbnail(key, rendered)
    return reply
      .type(rendered.mimeType)
      .header('Cache-Control', 'private, max-age=86400')
      .send(rendered.bytes)
  })
}
