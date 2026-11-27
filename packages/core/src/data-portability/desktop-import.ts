import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { prepareClientFields } from '../clients/clients.js'
import { databaseTime, nowUtc, uuid } from '../data/codec.js'
import type { Database } from '../data/schema.js'
import { DEFAULT_PROJECT_COLOR, PROJECT_COLOR_PRESETS, projectColorKey, projectColorValue } from '../projects/colors.js'
import { prepareProjectCreate } from '../projects/domain.js'
import { safeName } from '../projects/file-paths.js'
import { SqlProjectRepository } from '../projects/repository.js'
import type { DesktopMemoryFiles } from '../agent/memory/desktop-files.js'
import { restoreDesktopImMemory } from './desktop-im-memory.js'
import { restoreDesktopOwnerMemory } from './desktop-owner-memory.js'
import { restoreDesktopRelatedRecord } from './desktop-records.js'
import { withDesktopBusinessArchive, type PortableRecord } from './desktop-preflight.js'

const method = 'data-portability.desktop.import-record'

export async function importDesktopBusinessArchive(db: Kysely<Database>, ownerId: string, path: string, expectedDigest?: string, signal?: AbortSignal, memoryFiles?: DesktopMemoryFiles) {
  signal?.throwIfAborted()
  const applying = expectedDigest !== undefined
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const timestamp = databaseTime(nowUtc(), 'sqlite')
  const rollbackPreflight = new Error('归档预检回滚')
  let preview: { digest: string; added: number; skipped: number } | undefined
  const fingerprintFor = (origin: string, type: PortableRecord['type'], id: string) =>
    createHash('sha256').update(JSON.stringify([method, origin, type, id])).digest('hex')
  try {
    return await withDesktopBusinessArchive(path, expectedDigest, signal, archive => db.transaction().execute(async tx => {
      const projects = new SqlProjectRepository(tx, owner, 'sqlite', nowUtc)
      async function lookup(type: PortableRecord['type'], portableId: string) {
        const fingerprint = fingerprintFor(archive.origin, type, portableId)
        const receipt = await tx.selectFrom('core_operation_receipts').select('result_json')
          .where('owner_id', '=', owner).where('operation_id', '=', uuid(fingerprint.slice(0, 32)))
          .where('fingerprint', '=', fingerprint).where('method', '=', method).executeTakeFirst()
        const id = receipt && JSON.parse(receipt.result_json).targetId
        return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
      }
      let added = 0
      let skipped = archive.skippedFiles
      for await (const record of archive.records) {
        signal?.throwIfAborted()
        const fingerprint = fingerprintFor(archive.origin, record.type, record.portable_id)
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
        let targetId: number | undefined
        if ((record.type === 'project' || record.type === 'client') && record.relations?.length)
          throw new CoreError('invalid_request', '归档包含不支持的关系')
        if (record.type === 'account') {
          // 增量导入沿用旧版策略，账号身份由目标桌面端保留。
          skipped++
          continue
        }
        if (record.type === 'preferences') {
          const existing = (await sql`SELECT 1 FROM user_preferences WHERE user_id=${owner}`.execute(tx)).rows.length
          if (existing) { skipped++; continue }
          const data = record.fields.data
          if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new CoreError('invalid_request', '归档中的偏好设置格式无效')
          const keys = new Set(['locale', 'theme', 'theme_family', 'palette', 'last_stages', 'stage_templates',
            'custom_reply_style_enabled', 'custom_reply_style', 'pm_stages_expanded', 'calendar_week_start',
            'default_view', 'im_tool_display_mode', 'show_intermediate_replies', 'tool_injection_mode'])
          const body = JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => keys.has(key))))
          await sql`INSERT INTO user_preferences(user_id,updated_at,data_json) VALUES(${owner},${timestamp},${body})`.execute(tx)
        } else if (record.type === 'project') {
          const { done_at, ...fields } = record.fields
          if (done_at != null && typeof done_at !== 'string') throw new CoreError('invalid_request', '项目完成时间无效')
          // 旧归档的项目名可能包含路径保留字符，颜色也可能超出当前色板。
          if (typeof fields.name === 'string') fields.name = safeName(fields.name)
          if (typeof fields.color === 'string') {
            const key = projectColorKey(fields.color) ?? projectColorKey(projectColorValue(fields.color))
            fields.color = ['sunset', 'linear-gradient(135deg,#be8b8f,#c8aa72)'].includes(fields.color)
              ? PROJECT_COLOR_PRESETS[0] : projectColorValue(key) ?? DEFAULT_PROJECT_COLOR
          }
          const project = {
            ...prepareProjectCreate(fields), created_at: created,
            updated_at: record.updated_at ? databaseTime(record.updated_at, 'sqlite') : created,
            deleted_at: record.deleted_at ? databaseTime(record.deleted_at, 'sqlite') : null,
            done_at: done_at == null ? null : databaseTime(done_at, 'sqlite'),
          }
          targetId = (await projects.create(project)).id
        } else if (record.type === 'client') {
          if (record.deleted_at) throw new CoreError('invalid_request', '联系人归档包含已删除记录')
          // 旧归档的称呼仅用于完整恢复历史数据。
          const { contact, ...input } = record.fields
          if (contact != null && (typeof contact !== 'string' || Array.from(contact).length > 200))
            throw new CoreError('invalid_request', '归档中的历史联系人称呼无效')
          const fields = prepareClientFields(input, true)
          await tx.insertInto('clients').values({
              user_id: owner, name: String(fields.name), notes: String(fields.notes ?? ''),
              contact: contact ?? null, email: fields.email as string | null ?? null,
              phone: fields.phone as string | null ?? null, address: fields.address as string | null ?? null, created_at: created,
          }).execute()
        } else {
          targetId = await restoreDesktopRelatedRecord(tx, owner, record, created, lookup)
        }
        await tx.insertInto('core_operation_receipts').values({
          owner_id: owner, operation_id: operationId, fingerprint, method, created_at: timestamp, result_json: JSON.stringify({ targetId }),
        }).execute()
        added++
      }
      signal?.throwIfAborted()
      const memory = await restoreDesktopOwnerMemory(tx, owner, await archive.readOwnerMemory(), memoryFiles)
      const im = await restoreDesktopImMemory(tx, owner, ownerId, archive.readImMemory(), memoryFiles)
      const result = { digest: archive.digest, added: added + memory.added + im.added, skipped: skipped + memory.skipped + im.skipped }
      if (!applying) {
        preview = result
        throw rollbackPreflight
      }
      return result
    }))
  } catch (error) {
    if (error === rollbackPreflight && preview) return preview
    throw error
  }
}
