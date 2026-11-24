import { createHash } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type { FileUndoStorage } from './service.js'

type JsonObject = Record<string, unknown>
type UndoRow = QueryResultRow & {
  id: string
  user_id: string
  resource: string
  target_refs: unknown
  before_state: unknown
  after_state: unknown
  base_versions: unknown
  artifact_refs: unknown
}

function object(value: unknown): JsonObject {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('文件撤销记录格式无效')
  return parsed as JsonObject
}

function items(state: JsonObject): JsonObject {
  if (state.items == null) return {}
  return object(state.items)
}

function storageKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const key = (value as JsonObject).storage_key
  return typeof key === 'string' && key.length > 0 ? key : null
}

function pathDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 24)
}

function rewriteState(raw: unknown, refs: ReadonlyMap<string, string>): { value: JsonObject; changed: boolean } {
  const value = object(raw)
  const source = items(value)
  const next: JsonObject = {}
  let changed = false
  for (const [ref, snapshot] of Object.entries(source)) {
    const nextRef = refs.get(ref) ?? ref
    if (nextRef !== ref) changed = true
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      const copy = { ...(snapshot as JsonObject) }
      if (nextRef !== ref && Object.hasOwn(copy, 'id')) { delete copy.id; changed = true }
      next[nextRef] = copy
    } else next[nextRef] = snapshot
  }
  let nextState: JsonObject = { ...value, items: next }
  if (value.undo_versions != null) {
    const versions = object(value.undo_versions), nextVersions: JsonObject = {}
    for (const [ref, version] of Object.entries(versions)) {
      const nextRef = refs.get(ref) ?? ref
      if (nextRef !== ref) changed = true
      nextVersions[nextRef] = version
    }
    nextState = { ...nextState, undo_versions: nextVersions }
  }
  return { value: nextState, changed }
}

async function migrateRow(client: PoolClient, row: UndoRow, storage: FileUndoStorage): Promise<boolean> {
  if (!storage.move) throw new Error('文件撤销路径迁移缺少本地正文移动能力')
  const before = object(row.before_state), after = object(row.after_state)
  const beforeItems = items(before), afterItems = items(after)
  const refs = new Map<string, string>()
  for (const ref of new Set([...Object.keys(beforeItems), ...Object.keys(afterItems)])) {
    if (!/^file:[1-9]\d*$/.test(ref)) continue
    const key = storageKey(beforeItems[ref]) ?? storageKey(afterItems[ref])
    if (!key) throw new Error('旧文件撤销记录缺少路径快照')
    const owner = row.user_id.toLowerCase()
    if (!key.startsWith(`${owner}/`) && !key.startsWith(`${owner.replaceAll('-', '')}/.data-portability/imported/`))
      throw new Error('旧文件撤销路径归属无效')
    refs.set(ref, `file:${key}`)
  }

  const targetRefs = Array.isArray(row.target_refs) ? row.target_refs : JSON.parse(String(row.target_refs)) as unknown
  if (!Array.isArray(targetRefs)) throw new Error('文件撤销目标格式无效')
  let targetChanged = false
  const nextTargets = targetRefs.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const target = value as JsonObject
    if (target.kind !== 'file' || target.path !== undefined) return target
    const id = typeof target.id === 'number' ? target.id
      : typeof target.id === 'string' && /^[1-9]\d*$/.test(target.id) ? Number(target.id) : NaN
    if (!Number.isSafeInteger(id) || id < 1) return target
    const replacement = refs.get(`file:${id}`)
    if (!replacement) throw new Error('旧文件撤销目标缺少路径快照')
    targetChanged = true
    return { kind: 'file', path: replacement.slice('file:'.length) }
  })

  const beforeResult = rewriteState(before, refs)
  const afterResult = rewriteState(after, refs)
  const oldVersions = object(row.base_versions)
  const nextVersions: JsonObject = {}
  let versionsChanged = false
  for (const [ref, version] of Object.entries(oldVersions)) {
    const nextRef = refs.get(ref) ?? ref
    if (nextRef !== ref) versionsChanged = true
    nextVersions[nextRef] = version
  }

  const oldArtifacts = object(row.artifact_refs)
  const nextArtifacts: JsonObject = {}
  let artifactsChanged = false
  for (const [ref, rawEntry] of Object.entries(oldArtifacts)) {
    const nextRef = refs.get(ref) ?? ref
    if (nextRef !== ref) artifactsChanged = true
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      nextArtifacts[nextRef] = rawEntry
      continue
    }
    const entry = { ...(rawEntry as JsonObject) }
    const idMatch = row.resource === 'files' ? /^file:([1-9]\d*)$/.exec(ref) : null
    const keyMatch = /^file:(.+)$/.exec(nextRef)
    for (const field of ['before_key', 'after_key']) {
      const oldKey = entry[field]
      if (typeof oldKey !== 'string') continue
      if (!idMatch || !keyMatch) throw new Error('文件撤销正文引用无效')
      const parts = oldKey.split('/')
      const expectedOwner = row.user_id.toLowerCase()
      if (parts.length !== 5 || parts[0] !== expectedOwner || parts[1] !== '.undo'
        || !/^op-[0-9a-f]{32}$/.test(parts[2]!) || parts[3] !== `file-${idMatch[1]}`
        || !['before', 'after'].includes(parts[4]!)) throw new Error('旧文件撤销正文路径无效')
      const newKey = `${parts[0]}/.undo/${parts[2]}/file-${pathDigest(keyMatch[1]! )}/${parts[4]}`
      if (newKey !== oldKey) {
        const source = await storage.read(oldKey)
        const target = await storage.read(newKey)
        if (source !== null || target !== null) await storage.move(oldKey, newKey)
        entry[field] = newKey
        artifactsChanged = true
      }
    }
    nextArtifacts[nextRef] = entry
  }

  const changed = targetChanged || beforeResult.changed || afterResult.changed || versionsChanged || artifactsChanged
  if (!changed) return false
  await client.query(
    `UPDATE undo_operations SET target_refs=$3::json,before_state=$4::json,after_state=$5::json,
       base_versions=$6::json,artifact_refs=$7::json WHERE id=$1 AND user_id=$2`,
    [row.id, row.user_id, JSON.stringify(nextTargets), JSON.stringify(beforeResult.value), JSON.stringify(afterResult.value),
      JSON.stringify(nextVersions), JSON.stringify(nextArtifacts)],
  )
  return true
}

/** 将存量文件 Undo 记录和正文备份从数据库行号锚点迁为存储路径。 */
export async function migrateLegacyFileUndoAnchors(
  pool: Pick<Pool, 'connect' | 'query'>,
  storage: FileUndoStorage,
): Promise<number> {
  const schema = await pool.query<{ has_undo_operations: boolean }>(
    "SELECT to_regclass('undo_operations') IS NOT NULL AS has_undo_operations",
  )
  if (!schema.rows[0]?.has_undo_operations) return 0
  const client = await pool.connect()
  let begun = false
  try {
    await client.query('BEGIN')
    begun = true
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gugu-file-undo-path-migration'))")
    const selected = await client.query<UndoRow>(
      `SELECT id,user_id,resource,target_refs,before_state,after_state,base_versions,artifact_refs
       FROM undo_operations row WHERE resource IN ('files','projects') AND (
         EXISTS (SELECT 1 FROM jsonb_array_elements(row.target_refs::jsonb) target
                  WHERE target->>'kind'='file' AND target->>'id' ~ '^[1-9][0-9]*$')
         OR EXISTS (SELECT 1 FROM jsonb_each(row.before_state::jsonb->'items') item WHERE item.key ~ '^file:[1-9][0-9]*$')
         OR EXISTS (SELECT 1 FROM jsonb_each(row.after_state::jsonb->'items') item WHERE item.key ~ '^file:[1-9][0-9]*$')
       ) ORDER BY created_at,id FOR UPDATE`,
    )
    let migrated = 0
    for (const row of selected.rows) if (await migrateRow(client, row, storage)) migrated++
    await client.query('COMMIT')
    begun = false
    return migrated
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
