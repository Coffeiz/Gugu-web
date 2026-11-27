import { z } from 'zod'
import { Open } from 'unzipper'
import { CoreError } from '../../contracts/index.js'
import { createMcpSafeFetch } from '../../mcp/safe-fetch.js'
import type { ProviderTransport } from '../providers/contracts.js'
import { parseSkillDocument, SKILL_ENTRY_FILE } from './bundle.js'

const maxArchiveBytes = 10 * 1024 * 1024
const maxExpandedBytes = 30 * 1024 * 1024
const maxFiles = 500
const clawHubReference = /^@?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/u
const decoder = new TextDecoder('utf-8', { fatal: true })

function invalid(): never { throw new CoreError('invalid_request', '技能压缩包无效或超过大小限制') }

/** 将 ClawHub ZIP 验证为内存中的相对路径文件集合，不在验证阶段写入磁盘。 */
export async function readClawHubArchive(bytes: Uint8Array, signal: AbortSignal) {
  signal.throwIfAborted()
  if (bytes.byteLength > maxArchiveBytes || bytes.byteLength < 22) invalid()
  let archive: Awaited<ReturnType<typeof Open.buffer>>
  try { archive = await Open.buffer(Buffer.from(bytes)) }
  catch { return invalid() }
  if (archive.files.length > maxFiles) invalid()
  const files = new Map<string, Uint8Array>()
  const paths = new Set<string>()
  let total = 0
  for (const entry of archive.files) {
    signal.throwIfAborted()
    const path = entry.path
    const directory = path.endsWith('/')
    const parts = (directory ? path.slice(0, -1) : path).split('/')
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000
    if (!path || path.length > 1024 || path.includes('\\') || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))
      || parts[0]?.includes(':') || paths.has(path.toLowerCase()) || (entry.flags & 1)
      || (mode !== 0 && mode !== (directory ? 0x4000 : 0x8000)) || ![0, 8].includes(entry.compressionMethod)
      || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
      || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
      || entry.uncompressedSize > maxExpandedBytes || entry.uncompressedSize > entry.compressedSize * 500) invalid()
    paths.add(path.toLowerCase())
    if (directory) continue
    total += entry.uncompressedSize
    if (total > maxExpandedBytes) invalid()
    const chunks: Buffer[] = []
    let size = 0
    const stream = entry.stream()
    const abort = () => stream.destroy()
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      for await (const chunk of stream) {
        signal.throwIfAborted()
        const part = Buffer.from(chunk)
        size += part.length
        if (size > entry.uncompressedSize) invalid()
        chunks.push(part)
      }
      signal.throwIfAborted()
      if (size !== entry.uncompressedSize) invalid()
      files.set(path, Buffer.concat(chunks))
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof CoreError) throw error
      return invalid()
    } finally {
      signal.removeEventListener('abort', abort)
      stream.destroy()
    }
  }
  const source = files.get(SKILL_ENTRY_FILE)
  if (!source) invalid()
  const fileNames = new Set([...files.keys()].map(path => path.toLowerCase()))
  for (const path of fileNames) if (paths.has(`${path}/`)) invalid()
  for (const path of fileNames) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++)
      if (fileNames.has(parts.slice(0, index).join('/'))) invalid()
  }
  try { parseSkillDocument(decoder.decode(source)) }
  catch { return invalid() }
  return files
}

/** 固定访问 ClawHub 下载接口；传输与用户确认、落盘事务由宿主提供。 */
export function createClawHubDownload(transport: ProviderTransport) {
  const safeFetch = createMcpSafeFetch(transport, { timeoutMs: 30_000, maxResponseBytes: maxArchiveBytes })
  return async (reference: string, signal: AbortSignal) => {
    if (!clawHubReference.test(reference))
      throw new CoreError('invalid_request', '技能来源无效')
    const [owner, slug] = reference.replace(/^@/u, '').split('/')
    const url = new URL('https://clawhub.ai/api/v1/download')
    url.searchParams.set('slug', slug!)
    url.searchParams.set('ownerHandle', owner!)
    const response = await safeFetch(url, { signal })
    if (!response.ok) throw new CoreError('storage_error', '技能下载失败')
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('zip')) {
      await response.body?.cancel()
      throw new CoreError('invalid_request', '技能来源未提供可下载的压缩包')
    }
    return readClawHubArchive(new Uint8Array(await response.arrayBuffer()), signal)
  }
}

const ClawHubDetailsSchema = z.object({
  owner: z.object({ handle: z.string() }),
  skill: z.object({
    slug: z.string(),
    updatedAt: z.number().int().positive().max(8_640_000_000_000_000).nullish(),
    stats: z.object({ downloads: z.number().int().nonnegative().optional(),
      stars: z.number().int().nonnegative().optional(), installs: z.number().int().nonnegative().optional() }).nullish(),
  }),
  latestVersion: z.object({ version: z.string().max(100), license: z.string().max(100).nullish() }).nullish(),
})

/** 只读取技能正文，预览不暂存或安装文件。 */
export function createClawHubPreview(transport: ProviderTransport) {
  const download = createClawHubDownload(transport)
  const safeFetch = createMcpSafeFetch(transport, { timeoutMs: 8_000, maxResponseBytes: 1_000_000 })
  return async (reference: string, signal: AbortSignal) => {
    if (!clawHubReference.test(reference)) throw new CoreError('invalid_request', '技能来源无效')
    const archive = download(reference, signal)
    const [owner, slug] = reference.replace(/^@/u, '').split('/')
    const metadata = (async () => {
      const url = new URL(`https://clawhub.ai/api/v1/skills/${slug}`)
      url.searchParams.set('ownerHandle', owner!)
      const response = await safeFetch(url, { signal })
      if (!response.ok) { await response.body?.cancel(); return undefined }
      const parsed = ClawHubDetailsSchema.safeParse(await response.json())
      if (!parsed.success || parsed.data.owner.handle !== owner || parsed.data.skill.slug !== slug) return undefined
      const { skill, latestVersion } = parsed.data
      return { updatedAt: skill.updatedAt, ...skill.stats, version: latestVersion?.version, license: latestVersion?.license }
    })().catch(() => { signal.throwIfAborted(); return undefined })
    const [files, details] = await Promise.all([archive, metadata])
    const source = files.get(SKILL_ENTRY_FILE)
    if (!source) return invalid()
    const { body } = parseSkillDocument(decoder.decode(source))
    return { body, ...(details ? { details } : {}) }
  }
}
