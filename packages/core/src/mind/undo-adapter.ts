import { isDeepStrictEqual } from 'node:util'
import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database } from '../data/schema.js'

type Snapshot = Record<string, unknown>
type Items = Record<string, Snapshot>
export class MindUndoConflict extends Error {
  readonly code = 'undo.conflict'
  constructor(message = '资源已被其他操作修改，无法安全撤回') { super(message); this.name = 'MindUndoConflict' }
}
export class MindUndoUnsupported extends Error {
  readonly code = 'undo.unsupported'
  constructor() { super('撤销记录包含未知画布资源'); this.name = 'MindUndoUnsupported' }
}
const kinds = {
  canvas: { table: 'mind_maps', compare: ['title', 'project_id', 'data_json', 'deleted_at'], update: ['title', 'project_id', 'data_json'] },
  canvas_item: { table: 'mind_canvas_items', compare: ['canvas_id', 'node_id', 'x', 'y', 'w', 'h', 'z', 'collapsed', 'data_json', 'deleted_at'], update: ['x', 'y', 'w', 'h', 'z', 'collapsed', 'data_json'] },
  relation: { table: 'mind_relations', compare: ['canvas_id', 'src_node_id', 'dst_node_id', 'rel_type', 'edge_key', 'origin', 'status', 'note', 'deleted_at'], update: ['rel_type', 'edge_key', 'origin', 'status', 'note'] },
  note: { table: 'mind_nodes', compare: ['kind', 'title', 'content_md', 'content_plain', 'color', 'captured_at', 'deleted_at'], update: ['title', 'content_md', 'content_plain', 'color', 'captured_at', 'ref_snapshot'] },
  canvas_note: { table: 'mind_nodes', compare: ['kind', 'title', 'content_md', 'content_plain', 'color', 'captured_at', 'deleted_at'], update: ['title', 'content_md', 'content_plain', 'color', 'captured_at', 'ref_snapshot'] },
  ref_node: { table: 'mind_nodes', compare: ['kind', 'title', 'content_md', 'content_plain', 'color', 'captured_at', 'deleted_at'], update: ['title', 'content_md', 'content_plain', 'color', 'captured_at', 'ref_snapshot'] },
} as const
const integerFields = new Set(['project_id', 'canvas_id', 'node_id', 'src_node_id', 'dst_node_id'])
function comparable(value: unknown, field: string): unknown {
  if (value == null) return null
  if (field.endsWith('_at')) return utc(value instanceof Date ? value.toISOString() : value)
  if (field === 'collapsed' && (value === true || value === false || value === 0 || value === 1)) return Boolean(value)
  if (integerFields.has(field) && typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value)
  return value
}
/**
 * 调用方已在同一事务认领 Undo 行并负责提交后事件。
 * 使用 savepoint 防止中途失败留下部分资源变更，错误仍交给调用方处理。
 */
async function applyMindUndoWork(tx: Kysely<Database>, backend: Backend, rawOwner: string, operation: {
  id: string; action: string; before_state: { items?: Items }; after_state: { items?: Items; undo_versions?: Record<string, unknown> }
}, mode: 'undo' | 'redo', clock: Clock = nowUtc): Promise<{ versions: Record<string, unknown>; events: Array<Record<string, unknown>> }> {
  const canonical = dataContext(rawOwner).ownerId, owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
  const after = operation.after_state.items ?? {}, before = operation.before_state.items ?? {}
  const loaded = new Map<string, { spec: typeof kinds[keyof typeof kinds]; id: number }>()
  for (const [key, snapshot] of Object.entries(after)) {
    const match = /^(canvas|canvas_item|relation|note|canvas_note|ref_node):(\d+)$/.exec(key)
    if (!match) throw new MindUndoUnsupported()
    const spec = kinds[match[1] as keyof typeof kinds], id = Number(match[2])
    if (!Number.isSafeInteger(id)) throw new MindUndoUnsupported()
    const lock = sql.raw(backend === 'postgres' ? ' FOR UPDATE' : '')
    const precise = backend === 'postgres' ? sql.raw(spec.table === 'mind_nodes'
      ? `, to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00' AS captured_at, to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00' AS deleted_at`
      : `, to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00' AS deleted_at`) : sql``
    const row = (await sql<Snapshot>`SELECT *${precise} FROM ${sql.table(spec.table)} WHERE id=${id} AND user_id=${owner}${lock}`.execute(tx)).rows[0]
    if (!row) throw new MindUndoConflict('画布资源已不存在，无法安全撤回')
    const expected = mode === 'redo' ? operation.after_state.undo_versions?.[key] : snapshot
    if (mode === 'redo' && spec.table === 'mind_nodes') {
      if (Number(row.version ?? 1) !== Number(expected ?? -1)) throw new MindUndoConflict()
    } else {
      if (!expected || typeof expected !== 'object') throw new MindUndoConflict()
      const previous = expected as Snapshot
      if (spec.compare.some(field => !isDeepStrictEqual(comparable(row[field], field), comparable(previous[field], field)))) throw new MindUndoConflict()
    }
    loaded.set(key, { spec, id })
  }
  const versions: Record<string, unknown> = {}, now = databaseTime(clock(), backend)
  for (const [key, { spec, id }] of loaded) {
    if (mode === 'redo' && operation.action !== 'create' && operation.action !== 'delete' && !(key in before)) continue
    const snapshot = after[key]!
    const target: Snapshot = mode === 'redo' ? snapshot : operation.action === 'create' ? { ...snapshot, deleted_at: now } : operation.action === 'delete' ? before[key] ?? { ...snapshot, deleted_at: null } : before[key] ?? snapshot
    const fields = [...spec.update.filter(field => field in target), 'deleted_at']
    const assignments = fields.map(field => {
      let value = target[field] ?? null
      if (value !== null && field.endsWith('_at')) value = databaseTime(value instanceof Date ? value.toISOString() : String(value), backend)
      if (value !== null && field === 'collapsed' && backend === 'sqlite') value = Number(value)
      if (value !== null && field === 'ref_snapshot' && typeof value !== 'string') value = JSON.stringify(value)
      return sql`${sql.ref(field)} = ${value}`
    })
    if (spec.table === 'mind_nodes') assignments.push(sql`version = COALESCE(version, 1) + 1`)
    assignments.push(sql`updated_at = ${now}`)
    const precise = backend === 'postgres' ? sql.raw(`, to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00' AS deleted_at`) : sql``
    const result = (await sql<Snapshot>`UPDATE ${sql.table(spec.table)} SET ${sql.join(assignments)} WHERE id=${id} AND user_id=${owner} RETURNING *${precise}`.execute(tx)).rows[0]
    if (!result) throw new MindUndoConflict()
    if (spec.table === 'mind_nodes') versions[key] = Number(result.version ?? 1)
    else versions[key] = Object.fromEntries(['id', ...spec.compare].map(field => [field, result[field] ?? null]))
  }
  const eventOperation = operation.action === 'create' || operation.action === 'delete' ? ((operation.action === 'create') === (mode === 'undo') ? 'delete' : 'create') : 'update'
  return { versions, events: [{ resource: 'mind', operation: eventOperation, entity_ids: Object.keys(versions).map(key => Number(key.split(':')[1])), origin: `undo:${operation.id}` }] }
}

export async function applyMindUndoInTransaction(tx: Kysely<Database>, backend: Backend, rawOwner: string, operation: {
  id: string; action: string; before_state: { items?: Items }; after_state: { items?: Items; undo_versions?: Record<string, unknown> }
}, mode: 'undo' | 'redo', clock: Clock = nowUtc): Promise<{ versions: Record<string, unknown>; events: Array<Record<string, unknown>> }> {
  await sql`SAVEPOINT mind_undo_adapter`.execute(tx)
  try {
    const result = await applyMindUndoWork(tx, backend, rawOwner, operation, mode, clock)
    await sql`RELEASE SAVEPOINT mind_undo_adapter`.execute(tx)
    return result
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT mind_undo_adapter`.execute(tx)
    await sql`RELEASE SAVEPOINT mind_undo_adapter`.execute(tx)
    throw error
  }
}
