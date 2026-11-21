import { createHash, randomUUID } from 'node:crypto'
import { imageSize } from 'image-size'
import type { FileHandle } from 'node:fs/promises'
import { z } from 'zod'
import type { HistoryIdentity, Json, MessageEntry, RunIdentity, ToolCall, ToolResult } from '../models.js'
import type { ContextReferenceCodec } from '../ports.js'
import type { ProviderHttpResponse } from '../providers/contracts.js'
import type { ToolDefinition, ToolScope } from './contracts.js'

const maxBytes = 4 * 1024 * 1024
const maxPixels = 16_000_000
const ttl = 10 * 60_000
const mediaTypes = new Map([['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'], ['gif', 'image/gif']])
const baseSchema = z.union([
  z.object({ path: z.string().trim().min(1).max(2048) }).strict(),
  z.object({ url: z.url({ protocol: /^https?$/u }).max(2048).refine(value => {
    const url = new URL(value)
    return !url.username && !url.password
  }) }).strict(),
])

const attachmentSchema = z.object({ attach_id: z.string().regex(/^[0-9a-f]{32}$/u) }).strict()

type ImageEntry = { scope: string; data: string; digest: string; mime: string; expires: number }
const images = new Map<string, ImageEntry>()
const scopeKey = (identity: RunIdentity) => JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])
const hash = (data: string) => createHash('sha256').update(data).digest('hex')

function remember(scope: string, bytes: Buffer, mime: string): string {
  const id = randomUUID()
  for (const [key, image] of images) if (image.expires <= Date.now()) images.delete(key)
  while (images.size >= 16) images.delete(images.keys().next().value!)
  const data = bytes.toString('base64')
  images.set(id, { scope, data, digest: hash(data), mime, expires: Date.now() + ttl })
  return id
}

/** 只在原 Run 内恢复工具图片引用；checkpoint 与聊天记录不持久化图片正文。 */
export function withViewImageReferences(base: ContextReferenceCodec): ContextReferenceCodec {
  function convert(value: Json, scope: string, hydrate: boolean): Json {
    if (Array.isArray(value)) return value.map(item => convert(item, scope, hydrate))
    if (!value || typeof value !== 'object') return value
    if (hydrate && value.type === 'view-image-ref' && typeof value.id === 'string') {
      const image = images.get(value.id)
      return image?.scope === scope && image.expires > Date.now()
        ? { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }
        : { type: 'text', text: '图片已过期，请重新调用 view_image。' }
    }
    if (!hydrate && value.type === 'image' && value.source && typeof value.source === 'object' && !Array.isArray(value.source)
      && typeof value.source.data === 'string') {
      const digest = hash(value.source.data)
      for (const [id, image] of images)
        if (image.scope === scope && image.mime === value.source.media_type && image.digest === digest)
          return { type: 'view-image-ref', id }
    }
    if (value.type === 'tool-schema') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item, scope, hydrate)]))
  }
  const project = (entry: MessageEntry, identity: HistoryIdentity) => 'runId' in identity
    ? { ...entry, message: { ...entry.message, content: convert(entry.message.content, scopeKey(identity as RunIdentity), false) } }
    : entry
  return {
    ...(base.dehydrateBatch && { dehydrateBatch(entries, identity, signal, timing) {
      return base.dehydrateBatch!(entries.map(entry => project(entry, identity)), identity, signal, timing)
    } }),
    async hydrate(entry, identity, signal) {
      const message = await base.hydrate(entry, identity, signal)
      return 'runId' in identity ? { ...message, content: convert(message.content, scopeKey(identity as RunIdentity), true) } : message
    },
    dehydrate(entry, identity, signal) { return base.dehydrate(project(entry, identity), identity, signal) },
  }
}

type OpenedImageFile = { handle: FileHandle; size: number }

async function readImageFile(file: OpenedImageFile, signal: AbortSignal) {
  try {
    if (file.size < 1 || file.size > maxBytes) throw new Error()
    const bytes = Buffer.alloc(file.size + 1)
    let size = 0
    while (size < bytes.length) {
      signal.throwIfAborted()
      const { bytesRead } = await file.handle.read(bytes, size, bytes.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size !== file.size) throw new Error()
    return bytes.subarray(0, size)
  } finally { await file.handle.close() }
}

async function readUrl(open: (url: string, signal: AbortSignal) => Promise<ProviderHttpResponse>, url: string, signal: AbortSignal) {
  const response = await open(url, signal)
  try {
    if (response.status !== 200 || Number(response.headers['content-length']) > maxBytes) throw new Error()
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      size += chunk.byteLength
      if (size > maxBytes) throw new Error()
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  } finally { await response.cancel() }
}

/** 图片读取、校验和引用生命周期由 Web 与 Desktop 共用；宿主只注入授权根与安全公网传输。 */
export function createViewImageTool(options: {
  authorize(identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  supportsImage(identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  requiresHostConfirmation?: boolean
  openPath(identity: RunIdentity, path: string, signal: AbortSignal, scope: ToolScope, call: ToolCall):
    Promise<OpenedImageFile | Extract<ToolResult, { kind: 'waiting' }> | { error: string } | null>
  openAttachment?(identity: RunIdentity, attachId: string, signal: AbortSignal): Promise<OpenedImageFile | null>
  open(url: string, signal: AbortSignal): Promise<ProviderHttpResponse>
}): ToolDefinition {
  const error = (message: string) => ({
    kind: 'completed' as const, successful: false, mutated: false, executed: false, value: { error: message },
  })
  const supportsAttachments = !!options.openAttachment
  const schema = supportsAttachments ? z.union([baseSchema, attachmentSchema]) : baseSchema
  return {
    definition: { name: 'view_image', schema: { type: 'function', function: {
      name: 'view_image', description: '让当前模型查看一张图片。path 使用会话沙箱路径，url 使用公网 HTTP(S) 图片直链。支持 PNG、JPEG、WebP 和 GIF。GIF 按原始文件传给模型。'
        + (options.requiresHostConfirmation ? ' 桌面宿主机绝对路径需要会话文件访问授权，已添加的文件引用可直接读取。' : '')
        + (supportsAttachments ? ' 也可使用 attach_id 查看当前消息的图片附件。' : ''),
      parameters: { type: 'object', properties: {
        path: { type: 'string', minLength: 1, maxLength: 2048, description: '会话沙箱中的图片路径' },
        url: { type: 'string', format: 'uri', minLength: 1, maxLength: 2048, description: '公网 HTTP(S) 图片直链' },
        ...(supportsAttachments ? { attach_id: { type: 'string', pattern: '^[0-9a-f]{32}$' } } : {}),
      }, oneOf: (supportsAttachments ? ['path', 'url', 'attach_id'] : ['path', 'url'])
        .map(field => ({ required: [field], maxProperties: 1 })), additionalProperties: false },
    } } },
    effect: 'read',
    ...(options.requiresHostConfirmation ? { requiresInteraction: true, confirmationReplay: true } : {}),
    validate: input => schema.safeParse(input),
    async execute(value, scope, call) {
      const { identity, signal } = scope
      if (!await options.authorize(identity, signal)) return error('当前会话无权查看图片')
      if (!await options.supportsImage(identity, signal)) return error('当前模型不支持图片输入')
      try {
        const input = value as z.infer<typeof schema>
        if (scope.resolution && !('path' in input)) return error('图片目标或授权已变化，请重新发起操作')
        let bytes: Buffer
        if ('attach_id' in input) {
          const file = await options.openAttachment?.(identity, input.attach_id, signal)
          if (!file) return error('当前消息没有可用的图片附件')
          bytes = await readImageFile(file, signal)
        } else if ('path' in input) {
          const file = await options.openPath(identity, input.path, signal, scope, call)
          if (!file) return error(input.path.startsWith('/references/')
            ? '找不到这张引用图片，请重新拖入原文件后再试'
            : '无法从会话工作区读取这张图片，请检查路径，或重新添加图片引用')
          if ('kind' in file) return file
          if ('error' in file) return error(file.error)
          bytes = await readImageFile(file, signal)
        } else bytes = await readUrl(options.open, input.url, signal)
        const { type, width, height } = imageSize(bytes)
        const mime = type && mediaTypes.get(type)
        if (!mime || !width || !height || width * height > maxPixels) return error('图片格式或尺寸不受支持')
        if (!await options.authorize(identity, signal)) return error('图片查看权限已变化')
        signal.throwIfAborted()
        const id = remember(scopeKey(identity), bytes, mime)
        return { kind: 'completed', successful: true, mutated: false, value: { mime, width, height },
          modelValue: [{ type: 'text', text: `图片尺寸：${width} × ${height}` }, { type: 'view-image-ref', id }] }
      } catch {
        signal.throwIfAborted()
        return error('无法读取图片，请检查图片来源、格式和大小')
      }
    },
  }
}
