import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { mkdtemp, open, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Open } from 'unzipper'
import { z } from 'zod'
import { CoreError } from '../contracts/index.js'

const paths = {
  'README.txt': { category: 'archive_docs', type: null },
  'records/projects.jsonl': { category: 'projects', type: 'project' },
  'records/clients.jsonl': { category: 'clients', type: 'client' },
} as const

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const category = z.strictObject({ included: z.boolean(), records: count, bytes: count })
const entry = z.strictObject({ path: z.string(), category: z.string(), size: count,
  records: count.nullable().optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/u) })
const manifestSchema = z.strictObject({
  format_version: z.literal('1.0'), origin_id: z.guid(), export_id: z.guid(),
  created_at: z.iso.datetime({ offset: true }), complete: z.literal(false),
  categories: z.record(z.string(), category), entries: z.array(entry).max(3),
})
const recordedAt = z.string().refine(value => z.iso.datetime({ offset: true }).safeParse(value.replace(' ', 'T')).success)
const recordSchema = z.strictObject({
  record_schema: z.string(), portable_id: z.string().min(1).max(200), source_type: z.string(),
  created_at: recordedAt.nullable().optional(),
  updated_at: recordedAt.nullable().optional(),
  deleted_at: recordedAt.nullable().optional(),
  fields: z.record(z.string(), z.unknown()), relations: z.array(z.never()).max(0).optional(),
})
const decoder = new TextDecoder('utf-8', { fatal: true })
const allowedCategories = new Set([
  'account', 'preferences', 'projects', 'clients', 'files', 'calendar', 'mind', 'skills',
  'feedback', 'workspaces', 'scheduled_tasks', 'conversations', 'drafts', 'connections',
  'owner_memory', 'im_memory', 'archive_docs',
])

type ZipEntry = Awaited<ReturnType<typeof Open.file>>['files'][number]
type PortableRecord = z.infer<typeof recordSchema> & { type: 'project' | 'client' }
// 与现有 1.0 归档契约一致，限制单条 JSONL 记录和元数据，而非整个 ZIP。
export const maxDesktopArchiveRecordBytes = 8 * 1024 * 1024

function invalidArchive(): never {
  throw new CoreError('invalid_request', '归档损坏或超出桌面支持的项目和联系人范围')
}

async function directory(path: string) {
  const file = await open(path, 'r')
  let tail: Buffer
  let size: number
  try {
    size = (await file.stat()).size
    tail = Buffer.alloc(Math.min(size, 65_557))
    if ((await file.read(tail, 0, tail.length, size - tail.length)).bytesRead !== tail.length) invalidArchive()
  } finally { await file.close() }
  for (let end = tail.length - 22; end >= 0; end--) {
    if (tail.readUInt32LE(end) !== 0x06054b50 || end + 22 + tail.readUInt16LE(end + 20) !== tail.length) continue
    const entries = tail.readUInt16LE(end + 10)
    const directorySize = tail.readUInt32LE(end + 12)
    const offset = tail.readUInt32LE(end + 16)
    if (tail.readUInt32LE(end + 4) !== 0 || tail.readUInt16LE(end + 8) !== entries || entries < 3 || entries > 5
      || directorySize > 1024 * 1024 || offset + directorySize !== size - tail.length + end) invalidArchive()
    return Open.file(path, { tailSize: tail.length - end })
  }
  return invalidArchive()
}

async function* readEntry(entry: ZipEntry, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const stream = entry.stream()
  const abort = () => stream.destroy()
  signal?.addEventListener('abort', abort, { once: true })
  let expanded = 0
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      expanded += bytes.length
      if (expanded > entry.uncompressedSize) invalidArchive()
      yield bytes
    }
    signal?.throwIfAborted()
    if (expanded !== entry.uncompressedSize) invalidArchive()
  } finally {
    signal?.removeEventListener('abort', abort)
    stream.destroy()
  }
}

async function metadata(entry: ZipEntry, signal?: AbortSignal) {
  if (entry.uncompressedSize > maxDesktopArchiveRecordBytes) invalidArchive()
  const chunks: Buffer[] = []
  for await (const chunk of readEntry(entry, signal)) chunks.push(chunk)
  return decoder.decode(Buffer.concat(chunks))
}

async function readManifest(path: string, signal?: AbortSignal) {
  const zip = await directory(path)
  const files = new Map<string, ZipEntry>()
  for (const file of zip.files) {
    const name = file.path
    const mode = (file.externalFileAttributes >>> 16) & 0xf000
    if (files.has(name) || (!Object.hasOwn(paths, name) && name !== 'manifest.json' && name !== 'checksums.sha256')
      || (mode !== 0 && mode !== 0x8000) || (file.flags & 1)
      || ![0, 8].includes(file.compressionMethod) || file.uncompressedSize > file.compressedSize * 500) invalidArchive()
    files.set(name, file)
  }
  const manifestFile = files.get('manifest.json')
  const checksumsFile = files.get('checksums.sha256')
  if (!manifestFile || !checksumsFile || !files.has('README.txt')) invalidArchive()
  const manifest = manifestSchema.parse(JSON.parse(await metadata(manifestFile, signal)))
  const checksums = (await metadata(checksumsFile, signal)).trimEnd().split(/\r?\n/u)
  if (files.size !== manifest.entries.length + 2 || checksums.length !== manifest.entries.length) invalidArchive()
  const verified = new Set<string>()
  for (const item of manifest.entries) {
    if (!Object.hasOwn(paths, item.path) || verified.has(item.path)) invalidArchive()
    verified.add(item.path)
    const spec = paths[item.path as keyof typeof paths]
    const file = files.get(item.path)
    const group = manifest.categories[item.category]
    if (!file || file.uncompressedSize !== item.size || spec.category !== item.category
      || !checksums.includes(`${item.sha256}  ${item.path}`) || !group?.included
      || group.bytes !== item.size || group.records !== (item.records ?? 0)
      || (spec.type ? item.records == null : group.records !== 0)) invalidArchive()
  }
  for (const [key, group] of Object.entries(manifest.categories)) {
    if (!allowedCategories.has(key) || (!group.included && (group.records || group.bytes))
      || (group.included && !manifest.entries.some(item => item.category === key))) invalidArchive()
  }
  return { manifest, files }
}

async function* verifiedRecords(
  archive: Awaited<ReturnType<typeof readManifest>>,
  signal?: AbortSignal,
): AsyncGenerator<PortableRecord> {
  for (const item of archive.manifest.entries) {
    const file = archive.files.get(item.path)!
    const type = paths[item.path as keyof typeof paths].type
    const hash = createHash('sha256')
    const identities = new Set<string>()
    let parts: Buffer[] = []
    let length = 0
    function append(bytes: Buffer) {
      length += bytes.length
      if (length > maxDesktopArchiveRecordBytes) invalidArchive()
      if (bytes.length) parts.push(bytes)
    }
    function record(type: PortableRecord['type']): PortableRecord {
      const data = recordSchema.parse(JSON.parse(decoder.decode(Buffer.concat(parts, length))))
      parts = []
      length = 0
      if (data.source_type !== type || data.record_schema !== `gugu.${type}.v1` || identities.has(data.portable_id))
        invalidArchive()
      identities.add(data.portable_id)
      return { ...data, type }
    }
    for await (const data of readEntry(file, signal)) {
      hash.update(data)
      if (!type) continue
      let start = 0
      for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
        append(data.subarray(start, end))
        yield record(type)
        start = end + 1
      }
      append(data.subarray(start))
    }
    if (type && length) yield record(type)
    if (hash.digest('hex') !== item.sha256 || identities.size !== (item.records ?? 0)) invalidArchive()
  }
}

/** 暂存本次选定文件的快照，后续校验与数据写入读取相同字节。 */
export async function withDesktopBusinessArchive<T>(
  path: string,
  expectedDigest: string | undefined,
  signal: AbortSignal | undefined,
  work: (archive: { origin: string; digest: string; records: AsyncIterable<PortableRecord> }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'gugu-desktop-import-'))
  const snapshot = join(root, 'archive.zip')
  const hash = createHash('sha256')
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile()) invalidArchive()
      const space = await statfs(root, { bigint: true })
      if (BigInt(info.size) > space.bavail * space.bsize)
        throw new CoreError('storage_error', '暂存归档的磁盘空间不足')
      await pipeline(file.createReadStream({ autoClose: false }), new Transform({
        transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk) },
      }), createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }), { signal })
      const current = await file.stat()
      if (current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs)
        throw new CoreError('conflict', '读取时归档已变化，请重新预检')
    } finally { await file.close() }
    const digest = hash.digest('hex')
    if (expectedDigest !== undefined && digest !== expectedDigest)
      throw new CoreError('conflict', '归档已变化，请重新预检')
    let archive: Awaited<ReturnType<typeof readManifest>>
    try { archive = await readManifest(snapshot, signal) }
    catch (error) { signal?.throwIfAborted(); if (error instanceof CoreError) throw error; invalidArchive() }
    const records = verifiedRecords(archive, signal)
    async function* checkedRecords() {
      try { yield* records }
      catch (error) { signal?.throwIfAborted(); if (error instanceof CoreError) throw error; invalidArchive() }
    }
    return await work({ origin: archive.manifest.origin_id.toLowerCase(), digest, records: checkedRecords() })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
