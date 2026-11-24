import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { Database } from '../data/schema.js'
import type { DesktopMemoryFiles } from '../agent/memory/desktop-files.js'

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
] as const

// 此处统计本地 SQLite 记录。归档范围由后续的可移植投影定义。
export async function readDesktopDataInventory(db: Kysely<Database>, ownerId: string, memoryFiles?: Pick<DesktopMemoryFiles, 'readAll'>) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  return db.transaction().execute(async trx => {
    const counts: Record<string, number> = {}
    for (const [category, table, ownerColumn = 'user_id'] of sources) {
      const { rows } = await sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM ${sql.table(table)} WHERE ${sql.ref(ownerColumn)} = ${owner}
      `.execute(trx)
      counts[category] = (counts[category] ?? 0) + Number(rows[0]!.count)
    }
    const { rows: [conversation] } = await sql<{ messages: number; batches: number }>`
      SELECT (SELECT COUNT(*) FROM conversation_messages m JOIN conversation_sessions s ON s.id = m.session_id WHERE s.user_id = ${owner}) AS messages,
             (SELECT COUNT(*) FROM conversation_batches b JOIN conversation_sessions s ON s.id = b.session_id WHERE s.user_id = ${owner}) AS batches
    `.execute(trx)
    counts.desktop_messages = Number(conversation!.messages)
    counts.desktop_batches = Number(conversation!.batches)
    const queued = await sql<{ target: string; body: string }>`
      SELECT target, body FROM desktop_agent_memory WHERE user_id = ${owner}
      UNION ALL SELECT target, body FROM desktop_agent_memory_documents WHERE user_id = ${owner}
    `.execute(trx)
    const memory = new Map(Object.entries(await memoryFiles?.readAll() ?? {}))
    for (const row of queued.rows) memory.set(row.target, row.body)
    counts.owner_memory = [...memory.values()].filter(body => !['', '[]', '{}'].includes(body.trim())).length
    return counts
  })
}
