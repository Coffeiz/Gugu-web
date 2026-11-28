import { createHash, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import { createLocalAgentSkillMutationAdapter } from '#core-source/agent/tools/skill-management/file-storage.js'
import { createLocalFileSkillDeleteStorage } from '#core-source/agent/tools/skill-management/file-delete-storage.js'

/** SQLite 收据与 Undo 记录同事务；提交后通知桌面文件历史。 */
export function createDesktopAgentSkillMutationAdapter(options: {
  core: SqlDataRuntime
  dataRoot: string
  hostRequest(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}) {
  async function syncHistory(ownerId: string, operationId: string) {
    const id = `op-${operationId.replaceAll('-', '')}`
    const row = await options.core.db.selectFrom('undo_operations').select(['action', 'before_state', 'after_state'])
      .where('id', '=', id).where('user_id', '=', ownerId.replaceAll('-', '')).executeTakeFirst()
    if (!row) return
    const before = typeof row.before_state === 'string' ? JSON.parse(row.before_state) : row.before_state
    const after = typeof row.after_state === 'string' ? JSON.parse(row.after_state) : row.after_state
    if (!after || typeof after !== 'object' || Array.isArray(after)) throw new Error('技能历史无效')
    const value = after as Record<string, unknown>
    const old = before && typeof before === 'object' && !Array.isArray(before) ? before as Record<string, unknown> : {}
    await options.hostRequest('agent.files.recordSkillHistory', { operationId, slug: value.slug, storage_source: value.storage_source, action: row.action,
      before: row.action === 'install' ? null : old.source, after: value.source,
      packageDigest: row.action === 'install' ? value.digest : null })
  }
  const adapter = createLocalAgentSkillMutationAdapter({ dataRoot: options.dataRoot,
    async lock(_tx, _ownerId, _slug, operationId, signal) {
      await options.hostRequest('agent.files.acquireSkillLock', { operationId }, signal)
    },
    async release(_ownerId, operationId) { await options.hostRequest('agent.files.releaseSkillLock', { operationId }) },
    async knownTools() { return new Set() },
    async record(tx, history) {
      const owner = history.ownerId.replaceAll('-', '')
      const context = `agent:${history.sessionId}:${history.runId}`.slice(0, 128)
      const id = `op-${history.operationId.replaceAll('-', '')}`
      const group = `group-${randomUUID().replaceAll('-', '')}`
      const digest = (text: string) => createHash('sha256').update(text).digest('hex')
      const before = history.action === 'update' ? { source: history.before, digest: digest(history.before!) } : {}
      const after = history.action === 'update' ? { slug: history.slug, source: history.after, digest: digest(history.after), storage_source: 'user' }
        : { slug: history.slug, source: history.after, digest: history.packageDigest, storage_source: 'user' }
      await sql`UPDATE undo_operations SET status='expired', failure_code='redo_cleared_by_new_operation'
        WHERE user_id=${owner} AND undo_context_id=${context} AND actor_type='web' AND status='undone'`.execute(tx)
      await sql`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,
        before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
        VALUES(${id},${owner},${context},${group},'skills',${history.action},${JSON.stringify([{ kind: 'skill', slug: history.slug, storage_source: 'user' }])},
        ${JSON.stringify(before)},${JSON.stringify(after)},${'{}'},${'{}'},'web','active',CURRENT_TIMESTAMP,
        datetime('now','+30 days'),NULL,NULL)`.execute(tx)
    },
    publish: syncHistory,
  })
  return { ...adapter, replayed: syncHistory, requirePublished: true }
}

/** Agent 删除沿用桌面文件历史与当前操作锁，提交结果不确定时可重建历史。 */
export function createDesktopAgentSkillDeleteStorage(options: {
  core: SqlDataRuntime
  dataRoot: string
  hostRequest(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}) {
  async function syncHistory(ownerId: string, operationId: string) {
    const id = `op-${operationId.replaceAll('-', '')}`
    const row = await options.core.db.selectFrom('undo_operations').select(['after_state'])
      .where('id', '=', id).where('user_id', '=', ownerId.replaceAll('-', '')).where('action', '=', 'remove').executeTakeFirst()
    if (!row) throw new Error('技能删除历史不存在')
    const value = typeof row.after_state === 'string' ? JSON.parse(row.after_state) : row.after_state
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能删除历史无效')
    await options.hostRequest('agent.files.recordSkillHistory', { operationId, slug: value.slug, storage_source: value.storage_source, action: 'remove',
      before: null, after: null, packageDigest: value.digest })
  }
  return createLocalFileSkillDeleteStorage({ dataRoot: options.dataRoot,
    async lock(_tx, input, signal) { await options.hostRequest('agent.files.acquireSkillLock', { operationId: input.operationId }, signal) },
    async release(_owner, operationId) { await options.hostRequest('agent.files.releaseSkillLock', { operationId }) },
    async record(tx, input) {
      const owner = input.ownerId.replaceAll('-', '')
      const context = `agent:${input.identity.sessionId}:${input.identity.runId}`.slice(0, 128)
      const id = `op-${input.operationId.replaceAll('-', '')}`
      const group = `group-${randomUUID().replaceAll('-', '')}`
      await sql`UPDATE undo_operations SET status='expired', failure_code='redo_cleared_by_new_operation'
        WHERE user_id=${owner} AND undo_context_id=${context} AND actor_type='web' AND status='undone'`.execute(tx)
      await sql`INSERT INTO undo_operations(id,user_id,undo_context_id,group_id,resource,action,target_refs,
        before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at,expires_at,undone_at,failure_code)
        VALUES(${id},${owner},${context},${group},'skills','remove',${JSON.stringify([{ kind: 'skill', slug: input.id, storage_source: 'user' }])},
        ${'{}'},${JSON.stringify({ slug: input.id, digest: input.packageDigest, storage_source: 'user' })},${'{}'},${'{}'},'web','active',CURRENT_TIMESTAMP,
        datetime('now','+30 days'),NULL,NULL)`.execute(tx)
    },
    publish: syncHistory, replay: syncHistory, requirePublished: true,
  })
}
