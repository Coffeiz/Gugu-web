import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'

type UserSkillRow = {
  skill_id: string; name: string; description_short: string; description_long: string | null
  category: string; related_tools: string[] | string; body: string; source: string
  managed_by: string | null; enabled: boolean | number; content_digest: string
  created_at: Date | string | null; updated_at: Date | string | null
}

function timestamp(value: Date | string | null): string | null {
  if (value instanceof Date) return value.toISOString().replace(/\.000Z$/, '+00:00').replace(/Z$/, '+00:00')
  return value
}

/** Return the current owner's complete skill records for the management UI. */
export function createUserSkillLister<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite') {
  return async (rawOwner: string) => {
    const owner = dataContext(rawOwner).ownerId
    const key = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
    const rows = await sql<UserSkillRow>`
      SELECT skill_id,name,description_short,description_long,category,related_tools,body,source,managed_by,
             enabled,content_digest,created_at,updated_at
      FROM user_skills WHERE owner_id=${key} ORDER BY updated_at DESC,id DESC
    `.execute(db)
    return rows.rows.map(row => ({
      id: row.skill_id,
      name: row.name,
      description_short: row.description_short,
      description_long: row.description_long,
      category: row.category,
      related_tools: typeof row.related_tools === 'string' ? JSON.parse(row.related_tools) as string[] : row.related_tools,
      body: row.body,
      source: row.source,
      managed_by: row.managed_by || 'user',
      enabled: Boolean(row.enabled),
      content_digest: row.content_digest,
      created_at: timestamp(row.created_at),
      updated_at: timestamp(row.updated_at),
    }))
  }
}
