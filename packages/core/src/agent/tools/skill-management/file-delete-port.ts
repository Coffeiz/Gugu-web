import { createHash } from 'node:crypto'
import type { Transaction } from 'kysely'
import { CoreError, dataContext } from '../../../contracts/index.js'
import type { Database } from '../../../data/schema.js'
import type { SqlDataRuntime } from '../../../data/runtime.js'
import { stableJson } from '../../context/history/canonical-history.js'
import type { RunIdentity, ToolCall, ToolResult } from '../../models.js'
import type { ClientDeleteConfirmationPort } from '../clients/index.js'
import { readFileSkillDeleteTarget } from './file-delete-target.js'
import type { FileSkillDeletePort } from './file-delete.js'

type Identity = RunIdentity & { roundId: string }
type Coordinate = { ownerId: string; id: string; operationId: string; identity: Identity }
export interface FileSkillDeleteStorage {
  /** 事务内的锁必须与页面修改和撤销使用同一把锁。 */
  lock(tx: Transaction<Database>, coordinate: Coordinate, signal: AbortSignal): Promise<void>
  /** 无收据时恢复日志中相同操作未提交的移动；不得覆盖已有目标。 */
  recover(tx: Transaction<Database>, coordinate: Coordinate, signal: AbortSignal): Promise<void>
  /** 文件移动前持久化恢复日志；同事务写入可撤销的删除记录。 */
  remove(tx: Transaction<Database>, coordinate: Coordinate & { packageDigest: string }, signal: AbortSignal): Promise<{ rollback(): Promise<void>; finalize(): Promise<void> }>
  published(ownerId: string, operationId: string): Promise<void>
  replayed?(ownerId: string, operationId: string): Promise<void>
  release?(ownerId: string, operationId: string): Promise<void>
  requirePublished?: boolean
}

/** 与确认认领共享事务；无收据时在持锁状态恢复文件，避免重复删除。 */
export function createDurableFileSkillDeletePort(options: {
  core: SqlDataRuntime; dataRoot: string; storage: FileSkillDeleteStorage; confirmation: ClientDeleteConfirmationPort
  authorize(tx: Transaction<Database>, identity: RunIdentity, signal: AbortSignal): Promise<boolean>
}): FileSkillDeletePort {
  if (!options.core.receipts) throw new Error('删除技能需要持久操作收据')
  if (options.storage.requirePublished && !options.storage.replayed) throw new Error('技能历史恢复端口无效')
  const absent = new Error('技能删除收据不存在')
  const denied = new Error('技能删除权限或确认已失效')
  const failed = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })
  function coordinate(id: string, identity: Identity, call: ToolCall) {
    const ownerId = dataContext(identity.ownerId).ownerId
    const method = 'agent.file_skill.delete'
    const hex = createHash('sha256').update(stableJson([method, ownerId, identity.sessionId, identity.runId, identity.roundId, call.id])).digest('hex')
    const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    return { ownerId, id, identity, operationId, method }
  }
  async function reconcile(input: Parameters<FileSkillDeletePort['reconcile']>[0]): Promise<ToolResult> {
    const key = coordinate(input.id, input.identity, input.call), signal = new AbortController().signal
    try {
      const receipt = await options.core.operationWithTransaction(dataContext(key.ownerId), key.operationId, key.method, { id: key.id }, async tx => {
        if (!await options.authorize(tx, key.identity, signal)) throw denied
        await options.storage.lock(tx, key, signal)
        await options.storage.recover(tx, key, signal)
        throw absent
      })
      try { await options.storage.replayed?.(key.ownerId, key.operationId) }
      catch { if (options.storage.requirePublished) return { kind: 'unknown' } }
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return failed(error.message)
      return { kind: 'unknown' }
    } finally { await options.storage.release?.(key.ownerId, key.operationId).catch(() => {}) }
  }
  return {
    reconcile,
    async remove({ target, claim, scope, call }) {
      const key = coordinate(target.slug, { ...scope.identity, roundId: scope.roundId }, call)
      let mutation: Awaited<ReturnType<FileSkillDeleteStorage['remove']>> | undefined
      try {
        const receipt = await options.core.operationWithTransaction(dataContext(key.ownerId), key.operationId, key.method, { id: key.id }, async tx => {
          if (!await options.authorize(tx, key.identity, scope.signal)) throw denied
          await options.storage.lock(tx, key, scope.signal)
          await options.storage.recover(tx, key, scope.signal)
          const current = await readFileSkillDeleteTarget(options.dataRoot, key.ownerId, key.id)
          if (current.targetsDigest !== target.targetsDigest || current.versionsDigest !== target.versionsDigest)
            throw new CoreError('conflict', '技能删除确认目标已变化')
          if (!await options.confirmation.claim(tx, claim, scope.signal)) throw denied
          mutation = await options.storage.remove(tx, { ...key, packageDigest: target.packageDigest }, scope.signal)
          try {
            if (!await options.authorize(tx, key.identity, scope.signal)) throw denied
            scope.signal.throwIfAborted()
            return { success: true, id: key.id, message: '已删除技能，可通过撤销恢复。' }
          } catch (error) { await mutation.rollback(); mutation = undefined; throw error }
        }, { signal: scope.signal })
        await mutation?.finalize().catch(() => {})
        try {
          if (receipt.replayed) await options.storage.replayed?.(key.ownerId, key.operationId)
          else await options.storage.published(key.ownerId, key.operationId)
        } catch { if (options.storage.requirePublished) return { kind: 'unknown' } }
        return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
      } catch (error) {
        // 宿主锁可能跨事务持有，恢复前先释放，避免同一操作等待自身。
        await options.storage.release?.(key.ownerId, key.operationId).catch(() => {})
        const recovered = await reconcile({ id: key.id, identity: key.identity, call })
        if (recovered.kind !== 'unknown') return recovered
        if (error === denied) return failed(denied.message)
        if (error instanceof CoreError && ['conflict', 'invalid_request', 'not_found'].includes(error.code)) return failed(error.message)
        return recovered
      } finally { await options.storage.release?.(key.ownerId, key.operationId).catch(() => {}) }
    },
  }
}
