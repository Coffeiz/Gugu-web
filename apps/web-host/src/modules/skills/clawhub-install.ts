import { randomUUID } from 'node:crypto'
import { mkdir, rename, rmdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '@gugu/core'
import { ensureSkillDirectory, skillPackageDigest, stageSkillPackage, type SkillStorageSource } from '@gugu/core/skills'
import { recordForwardUndoOperation } from '../undo/record.js'

/** 提交技能包并登记撤销操作，供新建和下载共同使用。 */
export function createWebSkillPackageCommitter(options: {
  pool: Pick<Pool, 'connect'>
  dataRoot: string
  publish(ownerId: string): Promise<unknown>
}) {
  return async (rawOwner: string, slug: string, files: ReadonlyMap<string, Uint8Array>, rawContext: string | null, signal: AbortSignal, storageSource: SkillStorageSource = 'user') => {
    const ownerId = dataContext(rawOwner).ownerId
    const context = rawContext?.trim().slice(0, 128)
    if (!context) throw new CoreError('invalid_request', '技能撤销上下文无效')
    await stageSkillPackage({ dataRoot: options.dataRoot, ownerId, slug, files, signal, storageSource,
      async commit({ stagedDirectory, targetDirectory }) {
        const digest = await skillPackageDigest(stagedDirectory)
        await ensureSkillDirectory(options.dataRoot, dirname(targetDirectory))
        const operationId = `op-${randomUUID().replaceAll('-', '')}`
        const client = await options.pool.connect()
        let moved = false, commitAttempted = false
        try {
          await client.query('BEGIN')
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`skill:${ownerId}:${slug}`])
          signal.throwIfAborted()
          try { await mkdir(targetDirectory, { mode: 0o700 }) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CoreError('conflict', '技能目录已存在')
            throw error
          }
          try { await rename(stagedDirectory, targetDirectory); moved = true }
          catch (error) { await rmdir(targetDirectory).catch(() => {}); throw error }
          await recordForwardUndoOperation(client, { operationId, userId: ownerId, contextId: context,
            resource: 'skills', action: 'install', targetRefs: [{ kind: 'skill', slug, storage_source: storageSource }],
            beforeState: {}, afterState: { slug, digest, storage_source: storageSource }, baseVersions: {} })
          signal.throwIfAborted()
          commitAttempted = true
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          if (moved && !commitAttempted && await skillPackageDigest(targetDirectory) === digest)
            await rename(targetDirectory, stagedDirectory)
          throw error
        } finally { client.release() }
      } })
    try { await options.publish(ownerId) } catch { /* 安装已提交，通知失败不撤销文件。 */ }
    return { id: slug }
  }
}


/** 下载并安装 ClawHub 技能。 */
export function createWebClawHubInstaller(options: {
  pool: Pick<Pool, 'connect'>
  dataRoot: string
  download(reference: string, signal: AbortSignal): Promise<ReadonlyMap<string, Uint8Array>>
  publish(ownerId: string): Promise<unknown>
}) {
  const commit = createWebSkillPackageCommitter(options)
  return async (owner: string, reference: string, context: string | null, signal: AbortSignal) => {
    const match = /^@?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/u.exec(reference)
    if (!match) throw new CoreError('invalid_request', '技能来源无效')
    const files = await options.download(reference, signal)
    return commit(owner, match[1]!, files, context, signal, 'clawhub')
  }
}
