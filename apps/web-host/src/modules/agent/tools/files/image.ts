import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { imageSize } from 'image-size'
import { z } from 'zod'
import { openAnchoredLocalFile } from '@gugu/fs/node'
import type { ContextReferenceCodec, HistoryIdentity, Json, MessageEntry, RunIdentity } from '@gugu/core/agent'
import type { ProviderHttpResponse } from '@gugu/core/providers'
import type { ToolDefinition } from '@gugu/core/tools'
import type { ShellMountPlan } from '../../../terminals/sandbox/bubblewrap.js'

const maxBytes = 4 * 1024 * 1024
const maxPixels = 16_000_000
const ttl = 10 * 60_000
const mediaTypes = new Map([['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'], ['gif', 'image/gif']])
const schema = z.union([
  z.object({ path: z.string().trim().min(1).max(2048) }).strict(),
  z.object({ url: z.url({ protocol: /^https?$/u }).max(2048).refine(value => {
    const url = new URL(value)
    return !url.username && !url.password
  }) }).strict(),
])

type ImageEntry = { scope: string; data: string; digest: string; mime: string; expires: number }
const images = new Map<string, ImageEntry>()
const scopeKey = (identity: RunIdentity) => JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])
const hash = (data: string) => createHash('sha256').update(data).digest('hex')

function remember(scope: string, bytes: Buffer, mime: string): string {
  const id = randomUUID()
  for (const [key, image] of images) if (image.expires <= Date.now()) images.delete(key)
  // 进程内有界缓存，checkpoint 和聊天记录只携带引用。
  while (images.size >= 16) images.delete(images.keys().next().value!)
  const data = bytes.toString('base64')
  images.set(id, { scope, data, digest: hash(data), mime, expires: Date.now() + ttl })
  return id
}

/** 工具图片只在原 Run 内还原；缓存过期或进程重启后可重新查看。 */
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
    dehydrate(entry, identity, signal) {
      return base.dehydrate(project(entry, identity), identity, signal)
    },
  }
}

async function readPath(mount: ShellMountPlan, requested: string, signal: AbortSignal): Promise<Buffer> {
  if (requested.includes('\\') || requested.includes('\0') || requested.split('/').includes('..')) throw new Error()
  const path = posix.resolve(mount.sandboxCwd, requested)
  const entry = [...mount.sandboxMounts].sort((a, b) => b.target.length - a.target.length)
    .find(item => path === item.target || path.startsWith(item.target + '/'))
  if (entry?.descriptor === undefined || path === entry.target) throw new Error()
  const file = await openAnchoredLocalFile(entry.descriptor, path.slice(entry.target.length + 1))
  if (!file) throw new Error()
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

export function createViewImageTool(options: {
  authorize(identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  supportsImage(identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  mount(identity: RunIdentity, signal: AbortSignal): Promise<ShellMountPlan | null>
  open(url: string, signal: AbortSignal): Promise<ProviderHttpResponse>
}): ToolDefinition {
  const error = (message: string) => ({
    kind: 'completed' as const, successful: false, mutated: false, executed: false, value: { error: message },
  })
  return {
    definition: { name: 'view_image', schema: { type: 'function', function: {
      name: 'view_image', description: '让当前模型查看一张图片。path 使用会话沙箱路径，url 使用公网 HTTP(S) 图片直链，二选一。支持 PNG、JPEG、WebP 和 GIF。GIF 按原始文件传给模型。',
      parameters: { type: 'object', properties: {
        path: { type: 'string', minLength: 1, maxLength: 2048, description: '会话沙箱中的图片路径' },
        url: { type: 'string', format: 'uri', minLength: 1, maxLength: 2048, description: '公网 HTTP(S) 图片直链' },
      }, oneOf: [
        { required: ['path'], not: { required: ['url'] } },
        { required: ['url'], not: { required: ['path'] } },
      ], additionalProperties: false },
    } } },
    effect: 'read', validate: input => schema.safeParse(input),
    async execute(value, { identity, signal }) {
      if (!await options.authorize(identity, signal)) return error('当前会话无权查看图片')
      if (!await options.supportsImage(identity, signal)) return error('当前模型不支持图片输入')
      try {
        const input = value as z.infer<typeof schema>
        let bytes: Buffer
        if ('path' in input) {
          const mount = await options.mount(identity, signal)
          if (!mount) return error('当前会话没有可用的沙箱图片路径')
          try { bytes = await readPath(mount, input.path, signal) }
          finally { await mount.close() }
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
        return error('无法读取图片，请确认路径或公网直链，并检查图片格式和大小')
      }
    },
  }
}
