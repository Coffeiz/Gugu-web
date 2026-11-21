import { sql, type Transaction } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database } from '../data/schema.js'

/** 文件节点保留路径引用，负数仅用作内部画布节点唯一键。 */
export async function createPathFileCanvasNode(
  tx: Transaction<Database>, backend: Backend, ownerId: string, value: unknown, clock: Clock = nowUtc,
) {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
    || !/^(path|drop)-[A-Za-z0-9_-]{1,24000}$/u.test(value.id)
    || !('label' in value) || typeof value.label !== 'string' || !value.label || [...value.label].length > 255)
    throw new CoreError('invalid_request', '画布文件引用无效')
  const canonical = dataContext(ownerId).ownerId
  const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
  if (backend === 'postgres') {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${'mind:file-reference:' + canonical}))`.execute(tx)
  }
  const storedId = backend === 'postgres' ? sql`ref_snapshot->>'fileReferenceId'` : sql`json_extract(ref_snapshot,'$.fileReferenceId')`
  const existing = await tx.selectFrom('mind_nodes').selectAll()
    .where('user_id', '=', owner).where('ref_type', '=', 'file').where('ref_id', '<', 0)
    .where('deleted_at', 'is', null).where(sql<boolean>`${storedId}=${value.id}`).executeTakeFirst()
  if (existing) return { node: existing, created: false }
  const { rows: [slot] } = await sql<{ next: number }>`SELECT COALESCE(MIN(ref_id),0)-1 AS next FROM mind_nodes
    WHERE user_id=${owner} AND ref_type='file' AND ref_id<0`.execute(tx)
  const now = databaseTime(clock(), backend)
  const node = await tx.insertInto('mind_nodes').values({
    user_id: owner, kind: 'ref', title: value.label, content_md: '', content_plain: '', color: null,
    ref_type: 'file', ref_id: Number(slot!.next), ref_snapshot: JSON.stringify({ fileReferenceId: value.id }),
    origin: 'user', version: 1, captured_at: now, created_at: now, updated_at: now,
  }).returningAll().executeTakeFirstOrThrow()
  return { node, created: true }
}
