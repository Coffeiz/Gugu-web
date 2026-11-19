import type { PoolClient } from 'pg'
import { MindUndoConflict, MindUndoUnsupported } from './mind.js'

type Snapshot = Record<string, unknown>
type Items = Record<string, Snapshot>

/** 仅读取当前 owner 的 Undo 正文；写入及数据库更新必须由调用方以可恢复事务协调。 */
export async function readFileUndoArtifact(
  ownerId: string, ref: string, artifactRefs: Record<string, unknown>, mode: 'undo' | 'redo',
  read: (relativeKey: string) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  const entry = artifactRefs[ref]
  if (entry == null) return null
  if (typeof entry !== 'object' || Array.isArray(entry)) throw new MindUndoUnsupported()
  const key = (entry as Record<string, unknown>)[mode === 'undo' ? 'before_key' : 'after_key']
  if (typeof key !== 'string') throw new MindUndoUnsupported()
  const match = /^file:([1-9]\d*)$/.exec(ref)
  // 历史 Node 写入可能为正文 artifact 生成独立操作 ID，不能假设其与 Undo 行 ID 相同。
  const escapedOwner = ownerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escapedOwner}/\\.undo/op-[0-9a-f]{32}/file-${match?.[1] ?? 'invalid'}/${mode === 'undo' ? 'before' : 'after'}$`)
  if (!match || !pattern.test(key)) throw new MindUndoUnsupported()
  const bytes = await read(key)
  if (bytes === null) throw new MindUndoConflict('撤销所需的文件正文已不存在')
  return bytes
}

/** 在产生任何文件副作用前锁定并校验同组资源。 */
export async function preflightFileUndo(
  client: PoolClient, ownerId: string,
  operation: { action: string, before_state: { items?: Items }, after_state: { items?: Items, undo_versions?: Record<string, unknown> } },
  mode: 'undo' | 'redo',
): Promise<Map<string, Snapshot>> {
  const after = operation.after_state.items ?? {}
  const before = operation.before_state.items ?? {}
  const items = mode === 'undo' || ['create', 'copy', 'delete'].includes(operation.action) ? after : before
  const rows = new Map<string, Snapshot>()
  // 所有调用方采用相同顺序获取行锁，避免相反顺序的批量操作相互等待。
  for (const ref of Object.keys(items).sort()) {
    const match = /^(file|folder):(\d+)$/.exec(ref)
    if (!match) throw new MindUndoUnsupported()
    const id = Number(match[2])
    if (!Number.isSafeInteger(id) || id < 1) throw new MindUndoUnsupported()
    const table = match[1] === 'file' ? 'files' : 'folders'
    const result = await client.query<Snapshot>(`SELECT * FROM ${table} WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, ownerId])
    const row = result.rows[0]
    const expected = mode === 'redo' ? operation.after_state.undo_versions?.[ref] : items[ref]?.version
    if (!row || expected == null || Number(row.version ?? 1) !== Number(expected)) throw new MindUndoConflict()
    rows.set(ref, row)
  }
  return rows
}
