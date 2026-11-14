import multipart from '@fastify/multipart'
import { CoreError } from '@gugu/core'
import { imageSizeFromFile } from 'image-size/fromFile'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { WriteRequestMetadata } from '../../app.js'
import { writeRequestMetadata } from '../../http/request.js'

export interface FileUploadInput {
  space: string
  projectId: number | null
  folderId: number | null
  workspaceDirectoryId: number | null
  stageName: string
  mindMapId: number | null
  onConflict: 'keep_both' | 'overwrite'
  overwriteFileId: number | null
}

export interface StagedUpload {
  input: FileUploadInput
  originalName: string
  mimeType: string | null
  path: string
  sizeBytes: number
  sha256: string
  imgWidth: number | null
  imgHeight: number | null
}

export interface FileUploadOperations {
  getUploadCapacity(ownerId: string, input: FileUploadInput): Promise<number | null>
  store(ownerId: string, upload: StagedUpload, metadata: WriteRequestMetadata): Promise<unknown>
}

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/bmp', 'image/heic', 'image/heif',
])

export interface FileUploadRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: FileUploadOperations
}

function integer(value: string | undefined, field: string): number | null {
  if (value === undefined || value === '') return null
  if (!/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', `${field} 无效`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CoreError('invalid_request', `${field} 无效`)
  return parsed
}

function inputFrom(fields: Map<string, string>): FileUploadInput {
  const onConflict = fields.get('on_conflict') ?? 'keep_both'
  if (onConflict !== 'keep_both' && onConflict !== 'overwrite')
    throw new CoreError('invalid_request', '冲突处理方式无效')
  const overwriteFileId = integer(fields.get('overwrite_file_id'), 'overwrite_file_id')
  if (onConflict === 'overwrite' && overwriteFileId === null)
    throw new CoreError('invalid_request', '覆盖上传缺少目标文件')
  if (onConflict === 'keep_both' && overwriteFileId !== null)
    throw new CoreError('invalid_request', '保留同名文件时不能指定覆盖目标')
  const space = fields.get('space') ?? 'personal'
  if (!['personal', 'project', 'workspace', 'mind', 'asset'].includes(space))
    throw new CoreError('invalid_request', '文件空间无效')
  const stageName = fields.get('stage_name') ?? ''
  if (stageName.length > 100) throw new CoreError('invalid_request', '阶段名称过长')
  return {
    space,
    projectId: integer(fields.get('project_id'), 'project_id'),
    folderId: integer(fields.get('folder_id'), 'folder_id'),
    workspaceDirectoryId: integer(fields.get('workspace_directory_id'), 'workspace_directory_id'),
    stageName,
    mindMapId: integer(fields.get('mind_map_id'), 'mind_map_id'),
    onConflict,
    overwriteFileId,
  }
}

function validPythonInteger(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value)
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value.trim())) return false
  return Number.isSafeInteger(Number(value.trim()))
}

function validateLocalPresignRequest(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError('invalid_request', '上传参数无效')
  const body = value as Record<string, unknown>
  if (typeof body.filename !== 'string' || !validPythonInteger(body.size_bytes))
    throw new CoreError('invalid_request', '上传参数无效')
  for (const field of ['mime_type', 'space', 'stage_name', 'on_conflict']) {
    if (body[field] !== undefined && typeof body[field] !== 'string')
      throw new CoreError('invalid_request', '上传参数无效')
  }
  for (const field of ['project_id', 'folder_id', 'workspace_directory_id', 'overwrite_file_id']) {
    if (body[field] !== undefined && body[field] !== null && !validPythonInteger(body[field]))
      throw new CoreError('invalid_request', '上传参数无效')
  }
}

function uploadError(): Error {
  const error = new Error('存储空间已满，无法上传') as Error & { statusCode: number }
  error.statusCode = 413
  return error
}

async function stageFile(
  file: NodeJS.ReadableStream,
  directory: string,
  capacity: number | null,
  mimeType: string | null,
): Promise<{ path: string; sizeBytes: number; sha256: string; imgWidth: number | null; imgHeight: number | null }> {
  const filePath = path.join(directory, 'upload')
  let sizeBytes = 0
  const hash = createHash('sha256')
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length
      if (capacity !== null && sizeBytes > capacity) return callback(uploadError())
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(file, measure, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }))
  let imgWidth: number | null = null
  let imgHeight: number | null = null
  const normalizedMimeType = mimeType?.toLowerCase()
  if (normalizedMimeType && IMAGE_MIMES.has(normalizedMimeType)) {
    try {
      const dimensions = await imageSizeFromFile(filePath)
      imgWidth = dimensions.width
      imgHeight = dimensions.height
    } catch {
      // 像 Python 上传路径一样，损坏或不受支持的图片不阻止文件上传。
    }
  }
  return { path: filePath, sizeBytes, sha256: hash.digest('hex'), imgWidth, imgHeight }
}

export function registerFileUploadRoutes(app: FastifyInstance, options: FileUploadRouteOptions): void {
  // 2.0 使用 Local 存储；与 Python 本地模式一致，由下一步 multipart 上传完成配额和归属校验。
  app.post('/api/v1/files/presign', { preHandler: options.requireUser }, async (request) => {
    validateLocalPresignRequest(request.body)
    return { mode: 'proxy' }
  })

  app.post('/api/v1/files', { preHandler: options.requireUser }, async (request, reply) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gugu-upload-'))
    try {
      const fields = new Map<string, string>()
      let staged: StagedUpload | null = null
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (staged) throw new CoreError('invalid_request', '上传文件必须是表单最后一项')
          if (fields.has(part.fieldname)) throw new CoreError('invalid_request', '上传表单字段重复')
          if (typeof part.value !== 'string') throw new CoreError('invalid_request', '上传表单字段无效')
          fields.set(part.fieldname, part.value)
          continue
        }
        if (staged) throw new CoreError('invalid_request', '每次只能上传一个文件')
        const input = inputFrom(fields)
        const ownerId = options.ownerIdFromRequest(request)
        const capacity = await options.operations.getUploadCapacity(ownerId, input)
        const mimeType = part.mimetype || null
        const file = await stageFile(part.file, directory, capacity, mimeType)
        if (part.file.truncated) throw uploadError()
        staged = {
          input,
          originalName: path.basename(part.filename || 'file').slice(0, 512),
          mimeType,
          ...file,
        }
      }
      if (!staged) throw new CoreError('invalid_request', '缺少上传文件')
      const result = await options.operations.store(options.ownerIdFromRequest(request), staged, writeRequestMetadata(request, { limitHeaders: true }))
      return reply.code(201).send(result)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

export function installFileUploadSupport(app: FastifyInstance): void {
  app.register(multipart, {
    limits: { files: 1, fields: 10, parts: 11, fieldSize: 4096, fileSize: Number.MAX_SAFE_INTEGER },
  })
}
