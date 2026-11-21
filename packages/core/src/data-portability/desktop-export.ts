import { createHash, randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { strToU8, Zip, ZipPassThrough } from 'fflate'
import type { Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { clientRecord, projectRecord, uuid } from '../data/codec.js'
import type { Database } from '../data/schema.js'
import { maxDesktopArchiveRecordBytes } from './desktop-preflight.js'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const zip32Boundary = 0xffffffff

/** path 是主进程创建的私有临时目录中的新文件。 */
export async function exportDesktopBusinessArchive(db: Kysely<Database>, ownerId: string, path: string, signal?: AbortSignal) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const origin = uuid(sha256('gugu.desktop.portability:' + owner).slice(0, 32))
  const entries: Array<{ path: string; category: string; size: number; sha256: string; records: number }> = []
  const categories: Record<string, { included: boolean; records: number; bytes: number }> = {}
  const output = await open(path, 'wx', 0o600)
  const chunks: Uint8Array[] = []
  let offset = 0
  const zip = new Zip((error, chunk) => {
    if (error) throw error
    if (chunk.length) chunks.push(chunk)
  })

  async function flush() {
    for (const chunk of chunks.splice(0)) {
      if (offset + chunk.byteLength >= zip32Boundary) throw new CoreError('invalid_request', '归档超出 ZIP32 格式容量')
      for (let start = 0; start < chunk.length;) {
        signal?.throwIfAborted()
        const { bytesWritten } = await output.write(chunk, start, chunk.length - start, offset)
        if (!bytesWritten) throw new CoreError('storage_error', '归档写入不完整')
        start += bytesWritten
        offset += bytesWritten
      }
    }
  }

  async function add(path: string, source: Iterable<string> | AsyncIterable<string>, category?: string) {
    const entry = new ZipPassThrough(path)
    zip.add(entry)
    const hash = createHash('sha256')
    let size = 0
    let records = 0
    for await (const text of source) {
      signal?.throwIfAborted()
      const data = strToU8(text)
      if (category && category !== 'archive_docs' && data.length > maxDesktopArchiveRecordBytes)
        throw new CoreError('invalid_request', '单条归档记录超出格式支持的大小')
      size += data.length
      hash.update(data)
      records++
      entry.push(data)
      await flush()
    }
    entry.push(new Uint8Array(), true)
    await flush()
    if (category) {
      if (category === 'archive_docs') records = 0
      entries.push({ path, category, size, sha256: hash.digest('hex'), records })
      categories[category] = { included: true, records, bytes: size }
    }
  }

  function record(type: string, key: number, created: string, updated: string | null, deleted: string | null, fields: object) {
    return JSON.stringify({
      record_schema: `gugu.${type}.v1`,
      portable_id: uuid(sha256(`${origin}:${type}:${key}:${created}`).slice(0, 32)),
      source_type: type, created_at: created, updated_at: updated, deleted_at: deleted, fields, relations: [],
    }) + '\n'
  }

  try {
    await db.transaction().execute(async tx => {
      async function* projects() {
        for await (const row of tx.selectFrom('projects').selectAll().where('user_id', '=', owner).orderBy('id').stream()) {
          const { id, created_at, updated_at, deleted_at, name, summary, client, status, start_date, deadline,
            color, progress, stages_json, current_stage, priority, archived, done_at } = projectRecord(row)
          const stages: unknown = JSON.parse(stages_json)
          if (!Array.isArray(stages)) throw new CoreError('storage_error', '项目阶段数据无效')
          yield record('project', id, created_at, updated_at, deleted_at, {
            name, summary, client, status, start_date, deadline, color, progress, stages, current_stage, priority, archived, done_at,
          })
        }
      }
      async function* clients() {
        for await (const row of tx.selectFrom('clients').selectAll().where('user_id', '=', owner).orderBy('id').stream()) {
          const { id, created_at, name, contact, email, phone, notes } = clientRecord(row)
          yield record('client', id, created_at, null, null, { name, contact, email, phone, notes })
        }
      }
      await add('records/projects.jsonl', projects(), 'projects')
      await add('records/clients.jsonl', clients(), 'clients')
    })
    await add('README.txt', ['咕咕用户数据归档\n格式版本：1.0\n本归档包含项目与联系人，可用于增量导入。\n'], 'archive_docs')
    await add('manifest.json', [JSON.stringify({
      format_version: '1.0', origin_id: origin, export_id: randomUUID(), created_at: new Date().toISOString(),
      complete: false, categories, entries,
    }) + '\n'])
    await add('checksums.sha256', entries.map(entry => `${entry.sha256}  ${entry.path}\n`))
    zip.end()
    await flush()
    await output.sync()
  } finally {
    zip.terminate()
    await output.close()
  }
}
