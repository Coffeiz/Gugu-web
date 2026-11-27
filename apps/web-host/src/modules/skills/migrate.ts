import { mkdir } from 'node:fs/promises'
import { sql } from 'kysely'
import type { SqlDataRuntime } from '@gugu/core/data'
import { cutoverLegacySkillBundles } from '@gugu/core/skills'

/** 服务接受请求或启动后台任务前，逐用户迁移旧技能；失败时保留旧记录并阻止启动。 */
export async function migrateWebSkillOwners(core: SqlDataRuntime, dataRoot: string) {
  const { rows } = await sql<{ owner_id: string }>`
    SELECT DISTINCT owner_id::text AS owner_id FROM user_skills WHERE source='user' ORDER BY owner_id::text`.execute(core.db)
  if (!rows.length) return
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  for (const { owner_id } of rows)
    await cutoverLegacySkillBundles({ db: core.db, backend: 'postgres', dataRoot, ownerId: owner_id })
}
