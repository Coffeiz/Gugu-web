import { constants } from 'node:fs'
import { lstat, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Transaction } from 'kysely'
import { CoreError } from '../../../contracts/index.js'
import type { Database } from '../../../data/schema.js'
import { userSkillDirectory } from '../../skills/bundle.js'
import { ensureSkillDirectory } from '../../skills/safe-directory.js'
import { createLocalSkillPackageMover } from '../../skills/package-move.js'
import { skillPackageDigest } from '../../skills/package-digest.js'
import type { FileSkillDeleteStorage } from './file-delete-port.js'

type Coordinate = Parameters<FileSkillDeleteStorage['lock']>[1]

/** 删除前同步记录日志，事务未知时用操作专属撤销目录恢复未提交的移动。 */
export function createLocalFileSkillDeleteStorage(options: {
  dataRoot: string
  lock: FileSkillDeleteStorage['lock']
  release?: FileSkillDeleteStorage['release']
  record(tx: Transaction<Database>, input: Coordinate & { packageDigest: string }): Promise<void>
  publish(ownerId: string, operationId: string): Promise<void>
  replay?(ownerId: string, operationId: string): Promise<void>
  requirePublished?: boolean
}): FileSkillDeleteStorage {
  const mover = createLocalSkillPackageMover(options.dataRoot)
  const location = (input: Coordinate) => {
    if (!/^[a-f0-9-]{36}$/u.test(input.operationId)) throw new CoreError('invalid_request', '技能操作标识无效')
    const live = userSkillDirectory(options.dataRoot, input.ownerId, input.id)
    const agent = dirname(dirname(dirname(live)))
    return { live, held: join(agent, '.skill-undo', `op-${input.operationId.replaceAll('-', '')}`, 'user', input.id),
      journal: join(agent, '.skill-journal', `${input.operationId}.delete.json`), operationId: `op-${input.operationId.replaceAll('-', '')}` }
  }
  const exists = async (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  const clear = async (ownerId: string, operationId: string) => {
    const path = join(options.dataRoot, ownerId, '.agent', '.skill-journal', `${operationId}.delete.json`)
    await rm(path, { force: true })
  }
  return {
    lock: options.lock, release: options.release, requirePublished: options.requirePublished,
    async recover(_tx, input) {
      const loc = location(input)
      let file
      try { file = await open(loc.journal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      let data: unknown
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > 4096) throw new CoreError('conflict', '技能删除日志无效')
        try { data = JSON.parse(await file.readFile('utf8')) }
        catch { throw new CoreError('conflict', '技能删除日志无效') }
      } finally { await file.close() }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CoreError('conflict', '技能删除日志无效')
      const journal = data as Record<string, unknown>
      if (journal.ownerId !== input.ownerId || journal.slug !== input.id || journal.operationId !== input.operationId
        || typeof journal.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(journal.digest))
        throw new CoreError('conflict', '技能删除日志不匹配')
      const [live, held] = await Promise.all([exists(loc.live), exists(loc.held)])
      if (held && !live) await mover.move({ ownerId: input.ownerId, slug: input.id, storageSource: 'user', operationId: loc.operationId, digest: journal.digest, mode: 'redo' })
      else if (!live || held) throw new CoreError('conflict', '技能删除恢复目标已变化')
      else if (await skillPackageDigest(loc.live) !== journal.digest) throw new CoreError('conflict', '技能删除恢复目标已变化')
      await rm(loc.journal)
    },
    async remove(tx, input, signal) {
      const loc = location(input)
      await ensureSkillDirectory(options.dataRoot, dirname(loc.journal))
      const file = await open(loc.journal, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await file.writeFile(JSON.stringify({ ownerId: input.ownerId, slug: input.id, operationId: input.operationId, digest: input.packageDigest })); await file.sync() }
      finally { await file.close() }
      signal.throwIfAborted()
      const rollback = await mover.move({ ownerId: input.ownerId, slug: input.id, storageSource: 'user', operationId: loc.operationId, digest: input.packageDigest, mode: 'undo' })
      await options.record(tx, input)
      return { async rollback() { await rollback(); await rm(loc.journal) }, async finalize() { await rm(loc.journal, { force: true }) } }
    },
    async published(ownerId, operationId) { await clear(ownerId, operationId); await options.publish(ownerId, operationId) },
    async replayed(ownerId, operationId) { await clear(ownerId, operationId); await (options.replay ?? options.publish)(ownerId, operationId) },
  }
}
