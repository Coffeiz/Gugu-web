import { randomUUID, createHash } from 'node:crypto'
import { sql } from 'kysely'
import { createLocalAgentSkillMutationAdapter, createLocalFileSkillDeleteStorage, type FileSkillMutationAdapter } from '@gugu/core/tools'

/** Web 的 Agent 技能文件变更复用普通技能 Undo 数据契约。 */
export function createWebAgentSkillMutationAdapter(options: {
  dataRoot: string
  knownTools(ownerId: string, related: readonly string[]): Promise<ReadonlySet<string>>
  publish(ownerId: string): Promise<void>
}): FileSkillMutationAdapter {
  return createLocalAgentSkillMutationAdapter({ ...options,
    async lock(tx, ownerId, slug) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill:${ownerId}:${slug}`}, 0))`.execute(tx)
    },
    async record(tx, history) {
      const context = `agent:${history.sessionId}:${history.runId}`.slice(0, 128)
      const operationId = `op-${history.operationId.replaceAll('-', '')}`
      const groupId = `group-${randomUUID().replaceAll('-', '')}`
      const digest = (text: string) => createHash('sha256').update(text).digest('hex')
      const before = history.action === 'update' ? { source: history.before, digest: digest(history.before!) } : {}
      const after = history.action === 'update' ? { slug: history.slug, source: history.after, digest: digest(history.after), storage_source: 'user' }
        : { slug: history.slug, digest: history.packageDigest, storage_source: 'user' }
      await sql`UPDATE undo_operations SET status='expired', failure_code='redo_cleared_by_new_operation'
        WHERE user_id=${history.ownerId} AND undo_context_id=${context} AND actor_type='web' AND status='undone'`.execute(tx)
      await sql`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,
        before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
        VALUES(${operationId},${history.ownerId},${context},${groupId},'skills',${history.action},
        ${JSON.stringify([{ kind: 'skill', slug: history.slug, storage_source: 'user' }])}::json,${JSON.stringify(before)}::json,
        ${JSON.stringify(after)}::json,${'{}'}::json,${'{}'}::json,'web','active',CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '30 days',NULL,NULL)`.execute(tx)
    },
  })
}

/** Agent 删除与页面技能删除共享目录锁和撤销记录格式。 */
export function createWebAgentSkillDeleteStorage(options: { dataRoot: string; publish(ownerId: string): Promise<void> }) {
  return createLocalFileSkillDeleteStorage({ ...options,
    async lock(tx, input) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill:${input.ownerId}:${input.id}`}, 0))`.execute(tx)
    },
    async record(tx, input) {
      const context = `agent:${input.identity.sessionId}:${input.identity.runId}`.slice(0, 128)
      const operationId = `op-${input.operationId.replaceAll('-', '')}`
      const groupId = `group-${randomUUID().replaceAll('-', '')}`
      await sql`UPDATE undo_operations SET status='expired', failure_code='redo_cleared_by_new_operation'
        WHERE user_id=${input.ownerId} AND undo_context_id=${context} AND actor_type='web' AND status='undone'`.execute(tx)
      await sql`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,
        before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
        VALUES(${operationId},${input.ownerId},${context},${groupId},'skills','remove',
        ${JSON.stringify([{ kind: 'skill', slug: input.id, storage_source: 'user' }])}::json,${'{}'}::json,
        ${JSON.stringify({ slug: input.id, digest: input.packageDigest, storage_source: 'user' })}::json,${'{}'}::json,${'{}'}::json,'web','active',CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '30 days',NULL,NULL)`.execute(tx)
    },
  })
}
