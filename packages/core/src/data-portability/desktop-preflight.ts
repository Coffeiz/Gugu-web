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
  'records/calendar/events.jsonl': { category: 'calendar', type: 'calendar_event' },
  'records/mind/canvases.jsonl': { category: 'mind', type: 'mind_map' },
  'records/mind/nodes.jsonl': { category: 'mind', type: 'mind_node' },
  'records/mind/canvas_items.jsonl': { category: 'mind', type: 'mind_canvas_item' },
  'records/mind/relations.jsonl': { category: 'mind', type: 'mind_relation' },
  'records/preferences.json': { category: 'preferences', type: 'preferences' },
  'records/account.json': { category: 'account', type: 'account' },
  'records/conversations/sessions.jsonl': { category: 'conversations', type: 'conversation' },
  'records/conversations/batches.jsonl': { category: 'conversations', type: 'conversation_batch' },
  'records/conversations/messages.jsonl': { category: 'conversations', type: 'message' },
  'records/scheduled_tasks.jsonl': { category: 'scheduled_tasks', type: 'scheduled_task' },
  'records/conversations/drafts.jsonl': { category: 'drafts', type: 'pending_queue' },
  'records/feedback.jsonl': { category: 'feedback', type: 'feedback' },
  'records/clients.jsonl': { category: 'clients', type: 'client' },
} as const

const memoryPaths = [
  'memory/owner/profile.json', 'memory/owner/pattern.json', 'memory/owner/daily.md',
  'memory/owner/memory.md', 'memory/owner/summary.json', 'memory/owner/stance.json',
  'memory/owner/lens.json', 'memory/legacy/facts.json', 'memory/legacy/facts.md',
  'memory/legacy/summary.md', 'memory/legacy/summary.ts',
]
const skippedPaths = {
  'records/workspaces/directories.jsonl': 'workspaces',
  'records/workspaces/bindings.jsonl': 'workspaces',
  'records/connections/providers.jsonl': 'connections',
  'records/connections/smtp.jsonl': 'connections',
  'records/connections/bots.jsonl': 'connections',
  'records/connections/mcp.jsonl': 'connections',
  'records/files/files.jsonl': 'files',
  'assets/files/file.bin': 'files',
  'records/conversations/attachments.jsonl': 'conversations',
  'assets/chat/chat_attachment.bin': 'conversations',
  'records/memory/entries.jsonl': 'im_memory',
  'records/memory/sources.jsonl': 'im_memory',
} as const
const imIndexPaths = ['memory/im/scopes.jsonl', 'memory/im/deletion_markers.jsonl']
const archivePaths = new Map<string, { category: string; type: (typeof paths)[keyof typeof paths]['type'] }>([
  ...Object.entries(paths),
  ...memoryPaths.map(path => [path, { category: 'owner_memory', type: null }] as const),
  ...Object.entries(skippedPaths).map(([path, category]) => [path, { category, type: null }] as const),
])
function archivePath(path: string) {
  return archivePaths.get(path) ?? (imIndexPaths.includes(path)
    || /^memory\/im\/scopes\/[a-f0-9]{32}\/(?:profile\.json|pattern\.json|summary\.json|daily\.md|memory\.md|members\.json)$/u.test(path)
    ? { category: 'im_memory', type: null } as const : undefined)
}
const maxEntries = 4096
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const category = z.strictObject({ included: z.boolean(), records: count, bytes: count })
const entry = z.strictObject({ path: z.string(), category: z.string(), size: count,
  records: count.nullable().optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/u) })
const manifestSchema = z.strictObject({
  format_version: z.literal('1.0'), origin_id: z.guid(), export_id: z.guid(),
  created_at: z.iso.datetime({ offset: true }), complete: z.boolean(),
  categories: z.record(z.string(), category), entries: z.array(entry).max(maxEntries),
})
const recordedAt = z.string().refine(value => z.iso.datetime({ offset: true }).safeParse(value.replace(' ', 'T')).success)
const recordSchema = z.strictObject({
  record_schema: z.string(), portable_id: z.string().min(1).max(200), source_type: z.string(),
  created_at: recordedAt.nullable().optional(),
  updated_at: recordedAt.nullable().optional(),
  deleted_at: recordedAt.nullable().optional(),
  fields: z.record(z.string(), z.unknown()), relations: z.array(z.strictObject({
    relation_type: z.string().min(1).max(80),
    target_type: z.string().min(1).max(80),
    target_portable_id: z.string().min(1).max(200),
  })).max(8).optional(),
})
const decoder = new TextDecoder('utf-8', { fatal: true })
const allowedCategories = new Set([
  'account', 'preferences', 'projects', 'clients', 'files', 'calendar', 'mind',
  'feedback', 'workspaces', 'scheduled_tasks', 'conversations', 'drafts', 'connections',
  'owner_memory', 'im_memory', 'archive_docs',
])

type ZipEntry = Awaited<ReturnType<typeof Open.file>>['files'][number]
export type PortableRecord = z.infer<typeof recordSchema> & { type: NonNullable<(typeof paths)[keyof typeof paths]['type']> }
// 与现有 1.0 归档契约一致，限制单条 JSONL 记录和元数据，而非整个 ZIP。
export const maxDesktopArchiveRecordBytes = 8 * 1024 * 1024

function invalidArchive(): never {
  throw new CoreError('invalid_request', '归档损坏或包含桌面端暂不支持的数据')
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
    if (tail.readUInt32LE(end + 4) !== 0 || tail.readUInt16LE(end + 8) !== entries || entries < 3 || entries > maxEntries + 2
      || directorySize > 4 * 1024 * 1024 || offset + directorySize !== size - tail.length + end) invalidArchive()
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
    if (files.has(name) || (!archivePath(name) && name !== 'manifest.json' && name !== 'checksums.sha256')
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
  const totals = new Map<string, { bytes: number; records: number }>()
  for (const item of manifest.entries) {
    if (!archivePath(item.path) || verified.has(item.path)) invalidArchive()
    verified.add(item.path)
    const spec = archivePath(item.path)!
    const file = files.get(item.path)
    const group = manifest.categories[item.category]
    if (!file || file.uncompressedSize !== item.size || spec.category !== item.category
      || !checksums.includes(`${item.sha256}  ${item.path}`) || !group?.included
      || (spec.type ? item.records == null : !Object.hasOwn(skippedPaths, item.path) && !imIndexPaths.includes(item.path) && (item.records ?? 0) !== 0)) invalidArchive()
    const total = totals.get(item.category) ?? { bytes: 0, records: 0 }
    total.bytes += item.size
    total.records += item.records ?? 0
    totals.set(item.category, total)
  }
  for (const [key, group] of Object.entries(manifest.categories)) {
    const total = totals.get(key)
    if ((total?.bytes ?? 0) !== group.bytes || (total?.records ?? 0) !== group.records
      || !allowedCategories.has(key) || (!group.included && (group.records || group.bytes))
      || (group.included && !total && !['owner_memory', 'files'].includes(key))) invalidArchive()
  }
  return { manifest, files }
}

async function* verifiedRecords(
  archive: Awaited<ReturnType<typeof readManifest>>,
  signal?: AbortSignal,
): AsyncGenerator<PortableRecord> {
  // 按依赖顺序读取，避免 ZIP 条目顺序影响关系解析。
  const entries = new Map(archive.manifest.entries.map(item => [item.path, item]))
  for (const path of new Set([...archivePaths.keys(), ...entries.keys()])) {
    const item = entries.get(path)
    if (!item) continue
    const file = archive.files.get(item.path)!
    const type = archivePath(path)!.type
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
      if (path.endsWith('.json')) {
        append(data)
        continue
      }
      let start = 0
      for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
        append(data.subarray(start, end))
        yield record(type)
        start = end + 1
      }
      append(data.subarray(start))
    }
    if (type && length) yield record(type)
    if (hash.digest('hex') !== item.sha256 || (type !== null && identities.size !== (item.records ?? 0))) invalidArchive()
  }
}

/** 暂存本次选定文件的快照，后续校验与数据写入读取相同字节。 */
export async function withDesktopBusinessArchive<T>(
  path: string,
  expectedDigest: string | undefined,
  signal: AbortSignal | undefined,
  work: (archive: { origin: string; digest: string; records: AsyncIterable<PortableRecord>; readOwnerMemory(): Promise<Map<string, string>>; readImMemory(): AsyncIterable<{ path: string; body: string; records: number }>; skippedFiles: number }) => Promise<T>,
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
    return await work({ origin: archive.manifest.origin_id.toLowerCase(), digest, records: checkedRecords(),
      skippedFiles: archive.manifest.entries.filter(item => Object.hasOwn(skippedPaths, item.path))
        .reduce((count, item) => count + (item.records ?? 0), 0),
      async *readImMemory() {
        const entries = archive.manifest.entries.filter(entry => entry.path.startsWith('memory/im/'))
        const ordered = [...entries.filter(entry => imIndexPaths.includes(entry.path)),
          ...entries.filter(entry => !imIndexPaths.includes(entry.path))]
        for (const entry of ordered) {
          if (!imIndexPaths.includes(entry.path) && entry.size > 2_000_000) invalidArchive()
          yield { path: entry.path, body: await metadata(archive.files.get(entry.path)!, signal), records: entry.records ?? 0 }
        }
      },
      async readOwnerMemory() {
        const result = new Map<string, string>()
        for (const path of memoryPaths) {
          const file = archive.files.get(path)
          if (!file) continue
          if (file.uncompressedSize > 2_000_000) invalidArchive()
          result.set(path, await metadata(file, signal))
        }
        return result
      }, })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
