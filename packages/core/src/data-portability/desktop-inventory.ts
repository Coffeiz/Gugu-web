import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { Database } from '../data/schema.js'

const sources = [
  ['preferences', 'user_preferences'],
  ['projects', 'projects'],
  ['clients', 'clients'],
  ['calendar', 'calendar_events'],
  ['mind', 'mind_nodes'],
  ['mind', 'mind_maps'],
  ['mind', 'mind_canvas_items'],
  ['mind', 'mind_relations'],
  ['skills', 'user_skills', 'owner_id'],
  ['scheduled_tasks', 'scheduled_tasks'],
  ['desktop_sessions', 'conversation_sessions'],
  ['owner_memory', 'desktop_agent_memory_documents'],
] as const

// 此处统计本地 SQLite 记录。归档范围由后续的可移植投影定义。
export async function readDesktopDataInventory(db: Kysely<Database>, ownerId: string) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  return db.transaction().execute(async trx => {
    const counts: Record<string, number> = {}
    for (const [category, table, ownerColumn = 'user_id'] of sources) {
      const { rows } = await sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM ${sql.table(table)} WHERE ${sql.ref(ownerColumn)} = ${owner}
      `.execute(trx)
      counts[category] = (counts[category] ?? 0) + Number(rows[0]!.count)
    }
    return counts
  })
}
