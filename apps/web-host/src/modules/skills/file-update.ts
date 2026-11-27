import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '@gugu/core'
import { patchSkillDocument, readSkillBundle, type SkillDocumentPatch, type SkillStorageSource } from '@gugu/core/skills'
import { createLocalFileUndoStorage } from '../files/storage/undo.js'
import { recordForwardUndoOperation } from '../undo/record.js'

/** 将文件技能的文档修改和撤销快照登记到同一事务，失败时恢复原文。 */
export function createWebFileSkillUpdater(options: {
  pool: Pick<Pool, 'connect'>
  dataRoot: string
  publish(ownerId: string): Promise<unknown>
}) {
  return async (rawOwner: string, slug: string, expectedDigest: string, patch: SkillDocumentPatch, rawContext: string | null, storageSource: SkillStorageSource = 'user') => {
    const owner = dataContext(rawOwner).ownerId
    const context = rawContext?.trim().slice(0, 128)
    if (!context || !/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new CoreError('invalid_request', '技能版本或撤销上下文无效')
    const client = await options.pool.connect()
    let replacement: Awaited<ReturnType<ReturnType<typeof createLocalFileUndoStorage>['replace']>> | undefined
    let commitAttempted = false
    let digest = ''
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`skill:${owner}:${slug}`])
      const previous = await readSkillBundle(options.dataRoot, owner, storageSource, slug)
      if (previous.contentDigest !== expectedDigest) throw new CoreError('conflict', '技能已变化，请刷新后重试')
      const source = patchSkillDocument(previous.source, patch)
      digest = createHash('sha256').update(source).digest('hex')
      if (source !== previous.source) {
        replacement = await createLocalFileUndoStorage(options.dataRoot).replace(`${owner}/.agent/skills/${storageSource}/${slug}/SKILL.md`, Buffer.from(source))
        await recordForwardUndoOperation(client, { operationId: `op-${randomUUID().replaceAll('-', '')}`,
          userId: owner, contextId: context, resource: 'skills', action: 'update', targetRefs: [{ kind: 'skill', slug }],
          beforeState: { source: previous.source, digest: previous.contentDigest, storage_source: storageSource },
          afterState: { slug, source, digest, storage_source: storageSource }, baseVersions: {} })
      }
      commitAttempted = true
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (replacement && !commitAttempted) await replacement.rollback()
      throw error
    } finally { client.release() }
    if (replacement) await replacement.finalize().catch(() => {})
    try { await options.publish(owner) } catch { /* 已提交的修改不因通知失败回滚。 */ }
    return { id: slug, content_digest: digest }
  }
}
