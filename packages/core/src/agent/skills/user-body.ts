import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'

interface UserSkillBodyRow {
  skill_id: string
  name: string
  body: string
  content_digest: string
}

/** 按 owner 读取单个启用中的用户 Skill；不读取停用或非 user 来源记录。 */
export function createUserSkillReader<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite') {
  return async (rawOwner: string, rawSkillId: string) => {
    const owner = dataContext(rawOwner).ownerId
    const key = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
    const skillId = String(rawSkillId ?? '').trim().toUpperCase()
    if (!/^U[1-9]\d*$/.test(skillId)) return null
    const row = (await sql<UserSkillBodyRow>`
      SELECT skill_id,name,body,content_digest
      FROM user_skills
      WHERE owner_id=${key} AND skill_id=${skillId} AND enabled=${backend === 'sqlite' ? 1 : true} AND source='user'
    `.execute(db)).rows[0]
    return row ? { id: row.skill_id, name: row.name, body: row.body, contentDigest: row.content_digest } : null
  }
}
