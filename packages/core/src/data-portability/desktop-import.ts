import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { prepareClientFields } from '../clients/clients.js'
import { databaseTime, nowUtc, uuid } from '../data/codec.js'
import type { Database } from '../data/schema.js'
import { prepareProjectCreate } from '../projects/domain.js'
import { SqlProjectRepository } from '../projects/repository.js'
import { withDesktopBusinessArchive } from './desktop-preflight.js'

const method = 'data-portability.desktop.import-record'

export async function importDesktopBusinessArchive(db: Kysely<Database>, ownerId: string, path: string, expectedDigest?: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const applying = expectedDigest !== undefined
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const timestamp = databaseTime(nowUtc(), 'sqlite')
  return withDesktopBusinessArchive(path, expectedDigest, signal, archive => db.transaction().execute(async tx => {
    const projects = new SqlProjectRepository(tx, owner, 'sqlite', nowUtc)
    let added = 0
    let skipped = 0
    for await (const record of archive.records) {
      signal?.throwIfAborted()
      const fingerprint = createHash('sha256').update(JSON.stringify([method, archive.origin, record.type, record.portable_id])).digest('hex')
      const operationId = uuid(fingerprint.slice(0, 32))
      const previous = await tx.selectFrom('core_operation_receipts').select(['fingerprint', 'method'])
        .where('owner_id', '=', owner).where('operation_id', '=', operationId).executeTakeFirst()
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.method !== method)
          throw new CoreError('conflict', '归档记录标识发生冲突')
        skipped++
        continue
      }
      const created = record.created_at ? databaseTime(record.created_at, 'sqlite') : timestamp
      if (record.type === 'project') {
        const { done_at, ...fields } = record.fields
        if (done_at != null && typeof done_at !== 'string') throw new CoreError('invalid_request', '项目完成时间无效')
        const project = {
          ...prepareProjectCreate(fields), created_at: created,
          updated_at: record.updated_at ? databaseTime(record.updated_at, 'sqlite') : created,
          deleted_at: record.deleted_at ? databaseTime(record.deleted_at, 'sqlite') : null,
          done_at: done_at == null ? null : databaseTime(done_at, 'sqlite'),
        }
        if (applying) await projects.create(project)
      } else {
        if (record.deleted_at) throw new CoreError('invalid_request', '联系人归档包含已删除记录')
        const fields = prepareClientFields(record.fields, true)
        if (applying) {
          await tx.insertInto('clients').values({
            user_id: owner, name: String(fields.name), notes: String(fields.notes ?? ''),
            contact: fields.contact as string | null ?? null, email: fields.email as string | null ?? null,
            phone: fields.phone as string | null ?? null, created_at: created,
          }).execute()
        }
      }
      if (applying) await tx.insertInto('core_operation_receipts').values({
        owner_id: owner, operation_id: operationId, fingerprint, method, created_at: timestamp, result_json: '{}',
      }).execute()
      added++
    }
    signal?.throwIfAborted()
    return { digest: archive.digest, added, skipped }
  }))
}
