import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '@gugu/core'
import { readSkillBundle, skillPackageDigest, type SkillStorageSource } from '@gugu/core/skills'
import { recordForwardUndoOperation } from '../undo/record.js'
import { createLocalSkillUndoStorage } from './undo-storage.js'

/** 把整个技能目录保存到撤销存储，并在业务事务中登记删除。 */
export function createWebFileSkillDeleter(options: { pool: Pick<Pool, 'connect'>; dataRoot: string; publish(ownerId: string): Promise<unknown> }) {
  return async (rawOwner: string, slug: string, expectedDigest: string, rawContext: string | null, storageSource: SkillStorageSource = 'user') => {
    const owner = dataContext(rawOwner).ownerId
    const context = rawContext?.trim().slice(0, 128)
    if (!context || !/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new CoreError('invalid_request', '技能版本或撤销上下文无效')
    const client = await options.pool.connect()
    let rollback: (() => Promise<void>) | undefined
    let commitAttempted = false
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`skill:${owner}:${slug}`])
      const current = await readSkillBundle(options.dataRoot, owner, storageSource, slug)
      if (current.contentDigest !== expectedDigest) throw new CoreError('conflict', '技能已变化，请刷新后重试')
      const digest = await skillPackageDigest(current.path)
      const operationId = `op-${randomUUID().replaceAll('-', '')}`
      rollback = await createLocalSkillUndoStorage(options.dataRoot).move({ ownerId: owner, slug, storageSource, operationId, digest, mode: 'undo' })
      await recordForwardUndoOperation(client, { operationId, userId: owner, contextId: context,
        resource: 'skills', action: 'remove', targetRefs: [{ kind: 'skill', slug, storage_source: storageSource }], beforeState: {},
        afterState: { slug, digest, storage_source: storageSource }, baseVersions: {} })
      commitAttempted = true
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (rollback && !commitAttempted) await rollback()
      throw error
    } finally { client.release() }
    try { await options.publish(owner) } catch { /* 已提交的删除不因通知失败回滚。 */ }
    return { id: slug }
  }
}
