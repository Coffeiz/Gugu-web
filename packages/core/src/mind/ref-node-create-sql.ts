import { sql, type Kysely, type Transaction, type Selectable } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindNodeTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { createPathFileCanvasNode } from './path-file-canvas.js'
import { MindRefNodeCreateError, type MindRefNodeCreateRuntime } from './ref-node-create.js'

const iso = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')).toISOString().replace(/Z$/, '+00:00')
function map(row: Selectable<MindNodeTable>) {
  let ref: unknown = row.ref_snapshot
  if (typeof ref === 'string') { try { ref = JSON.parse(ref) } catch { ref = null } }
  const date = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T'))
  return { ...row, id: Number(row.id), ref_id: row.ref_id === null ? null : Number(row.ref_id), ref_snapshot: ref && typeof ref === 'object' && !Array.isArray(ref) ? ref as Record<string, unknown> : null, captured_at: date(row.captured_at), created_at: date(row.created_at), updated_at: date(row.updated_at), deleted_at: row.deleted_at === null ? null : date(row.deleted_at) }
}
/** 目标查询、唯一引用节点与 Undo 同事务；file 要求宿主提供 files 表。 */
export function createSqlMindRefNodeCreateRuntime(db: Kysely<Database>, backend: Backend, publishChanged: MindRefNodeCreateRuntime['publishChanged'], reportFailure?: MindRefNodeCreateRuntime['reportFailure'], clock: Clock = nowUtc, resolveFileReference?: (owner: string, id: string) => Promise<{ label: string } | null>): MindRefNodeCreateRuntime {
  return { transaction: (rawOwner, work) => {
    const canonical = dataContext(rawOwner).ownerId, owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const run = async (tx: Transaction<Database>) => work({
      async create(_owner, type, id) {
        let target: { title: string; color: string | null; snapshot: Record<string, unknown> } | null = null
        if (type === 'file') {
          if (typeof id !== 'string')
            throw new MindRefNodeCreateError(422, '请使用文件路径引用')
          const file = await resolveFileReference?.(canonical, id)
          if (!file) throw new MindRefNodeCreateError(404, '引用文件已移动或不可访问')
          const result = await createPathFileCanvasNode(tx, backend, canonical, {
            id, label: Array.from(file.label).slice(0, 255).join(''),
          }, clock)
          return { node: map(result.node), created: result.created }
        }
        if (typeof id !== 'number') throw new MindRefNodeCreateError(422, '引用对象无效')
        if (type === 'project') {
          let query = tx.selectFrom('projects').select(['name', 'color', 'contact_name', 'status', 'start_date', 'deadline', 'done_at']).where('id', '=', id).where('user_id', '=', owner)
          if (backend === 'postgres') query = query.forUpdate()
          const row = await query.executeTakeFirst()
          if (row) target = { title: row.name, color: row.color, snapshot: { client: row.contact_name, status: row.status, startDate: row.start_date, deadline: row.deadline, doneAt: row.done_at ? iso(row.done_at) : null } }
        } else if (type === 'client') {
          let query = tx.selectFrom('clients').select('name').where('id', '=', id).where('user_id', '=', owner)
          if (backend === 'postgres') query = query.forUpdate()
          const row = await query.executeTakeFirst()
          if (row) target = { title: row.name, color: null, snapshot: {} }
        } else {
          const lock = sql.raw(backend === 'postgres' ? ' FOR UPDATE' : '')
          const row = (await sql<{ title: string; date: string; time: string | null; end_time: string | null }>`SELECT title, date, time, end_time FROM calendar_events WHERE id=${id} AND user_id=${owner}${lock}`.execute(tx)).rows[0]
          if (row) target = { title: row.title, color: null, snapshot: { date: row.date, time: row.time, endTime: row.end_time } }
        }
        if (!target) throw new MindRefNodeCreateError(404, '引用对象不存在')
        let query = tx.selectFrom('mind_nodes').selectAll().where('user_id', '=', owner).where('kind', '=', 'ref').where('ref_type', '=', type).where('ref_id', '=', id).where('deleted_at', 'is', null).orderBy('id')
        if (backend === 'postgres') query = query.forUpdate()
        const existing = await query.executeTakeFirst()
        if (existing) return { node: map(existing), created: false }
        const now = databaseTime(clock(), backend)
        const node = await tx.insertInto('mind_nodes').values({ user_id: owner, kind: 'ref', title: target.title, content_md: '', content_plain: '', color: target.color, ref_type: type, ref_id: id, ref_snapshot: JSON.stringify(target.snapshot), origin: 'user', indexed_at: null, indexed_hash: null, version: 1, captured_at: now, created_at: now, updated_at: now, deleted_at: null }).returningAll().executeTakeFirstOrThrow()
        return { node: map(node), created: true }
      },
      async recordUndo(record) { await recordForwardUndoOperation(tx, backend, { ...record, userId: canonical }, clock) },
    })
    return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run)
  }, publishChanged, reportFailure }
}
