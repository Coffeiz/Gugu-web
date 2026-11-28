import type { Kysely } from 'kysely'
import type { CanvasContactRef } from '../contracts/desktop.js'
import type { Database } from '../data/schema.js'

/** 画布联系人引用按已验证 owner 批量读取现有资料。 */
export async function readCanvasContactRefs(db: Kysely<Database>, owner: string, ids: readonly number[]) {
  if (!ids.length) return new Map<number, CanvasContactRef>()
  const rows = await db.selectFrom('clients')
    .select(['id', 'name', 'email', 'phone', 'address', 'notes'])
    .where('user_id', '=', owner).where('id', 'in', ids).execute()
  return new Map(rows.map(({ id, ...fields }) => [Number(id), fields]))
}
