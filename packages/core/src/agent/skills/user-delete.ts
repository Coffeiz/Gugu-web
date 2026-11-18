import {sql,type Kysely} from 'kysely'
import {dataContext,CoreError} from '../../contracts/index.js'

/** 删除与调用方共用连接，Agent 可在同一个事务中认领确认并写入收据。 */
export async function removeUserSkillRow<DB>(db: Kysely<DB>, ownerKey: string, skillId: string): Promise<boolean> {
  const result = await sql<{ id: number }>`DELETE FROM user_skills
    WHERE owner_id=${ownerKey} AND skill_id=${skillId} AND source='user' RETURNING id`.execute(db)
  return result.rows.length === 1
}

/** 删除只属于当前owner的用户技能；提交后的通知失败不能复活已删除记录。 */
export function createUserSkillDeletion<DB>(db:Kysely<DB>,backend:'postgres'|'sqlite',publishChanged:(ownerId:string)=>Promise<unknown>) {
  return async(ownerId:string,skillId:string):Promise<void>=>{
    const owner=dataContext(ownerId).ownerId
    const ownerKey=backend==='sqlite'?owner.replaceAll('-',''):owner
    if(!await removeUserSkillRow(db, ownerKey, skillId)) throw new CoreError('not_found','Skill 不存在')
    try {await publishChanged(owner)} catch { /* 与Python事件总线一致：通知best-effort，不回滚已提交删除。 */ }
  }
}
