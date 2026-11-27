import { createHash } from 'node:crypto'
import type { Transaction } from 'kysely'
import { CoreError, dataContext } from '../../../contracts/index.js'
import type { Database } from '../../../data/schema.js'
import type { SqlDataRuntime } from '../../../data/runtime.js'
import { UserSkillValidationError } from '../../skills/user-validation.js'
import { stableJson } from '../../context/history/canonical-history.js'
import type { RunIdentity, ToolCall, ToolResult } from '../../models.js'
import type { ToolScope } from '../contracts.js'
import type { FileSkillCreateInput, FileSkillManagementPort, FileSkillUpdateInput } from './file-tools.js'

type Action = 'create' | 'update'
type Input = FileSkillCreateInput | FileSkillUpdateInput

/** 变更须在 apply 内将文件历史写入借用的事务，并允许进程重启后按操作标识恢复。 */
export interface PreparedFileSkillMutation {
  apply(tx: Transaction<Database>, signal: AbortSignal): Promise<unknown>
  rollback(tx: Transaction<Database>): Promise<void>
  finalize(): Promise<void>
}

export interface FileSkillMutationAdapter {
  prepare(input: { action: Action; fields: Input; identity: RunIdentity; operationId: string;
    relatedTools: readonly string[]; signal: AbortSignal }): Promise<PreparedFileSkillMutation>
  /** 没有事务收据时检查并恢复上次可能已写入的文件，不得重复提交。 */
  recover(input: { action: Action; fields: Input; identity: RunIdentity; operationId: string; tx: Transaction<Database>; signal: AbortSignal }): Promise<void>
  published(ownerId: string, operationId: string): Promise<void>
  replayed?(ownerId: string, operationId: string): Promise<void>
  requirePublished?: boolean
  release?(ownerId: string, operationId: string): Promise<void>
}

function operation(identity: RunIdentity, roundId: string, callId: string, action: Action) {
  const context = dataContext(identity.ownerId)
  const method = `agent.file_skill.${action}`
  const hex = createHash('sha256').update(stableJson([method, context.ownerId, identity.sessionId, identity.runId, roundId, callId])).digest('hex')
  return { context, method, operationId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` }
}

/** 统一绑定租约、收据和文件事务；提交结果不确定时仅走恢复，不重新写入。 */
export function createDurableFileSkillManagementPort(options: {
  core: SqlDataRuntime
  adapter: FileSkillMutationAdapter
  authorize(tx: Transaction<Database>, identity: RunIdentity, signal: AbortSignal): Promise<boolean>
}): FileSkillManagementPort {
  if (!options.core.receipts) throw new Error('技能写入需要持久操作收据')
  if (options.adapter.requirePublished && !options.adapter.replayed) throw new Error('技能历史恢复端口无效')
  const absent = new Error('技能写入收据不存在')
  const denied = new Error('当前运行无权写入技能')
  const failure = (message: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error: message } })
  async function reconcile(action: Action, input: Input, identity: RunIdentity & { roundId: string }, call: ToolCall): Promise<ToolResult> {
    const key = operation(identity, identity.roundId, call.id, action)
    try {
      const receipt = await options.core.operationWithTransaction(key.context, key.operationId, key.method, input, async () => { throw absent })
      try { await options.adapter.replayed?.(key.context.ownerId, key.operationId) }
      catch { if (options.adapter.requirePublished) return { kind: 'unknown' } }
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return failure(error.message)
      return { kind: 'unknown' }
    }
  }
  async function execute(action: Action, input: Input, scope: ToolScope, call: ToolCall): Promise<ToolResult> {
    const { identity, roundId, signal } = scope
    signal.throwIfAborted()
    const key = operation(identity, roundId, call.id, action)
    const existing = await reconcile(action, input, { ...identity, roundId }, call)
    if (existing.kind !== 'unknown') return existing
    const tools = scope.discoverRelatedTools ? (await scope.discoverRelatedTools()).map(tool => tool.name) : []
    signal.throwIfAborted()
    let mutation: PreparedFileSkillMutation | undefined
    let applied = false
    try {
      const receipt = await options.core.operationWithTransaction(key.context, key.operationId, key.method, input, async tx => {
        if (!await options.authorize(tx, identity, signal)) throw denied
        signal.throwIfAborted()
        await options.adapter.recover({ action, fields: input, identity, operationId: key.operationId, tx, signal })
        mutation = await options.adapter.prepare({ action, fields: input, identity, operationId: key.operationId, relatedTools: tools, signal })
        signal.throwIfAborted()
        applied = true
        try {
          const value = await mutation.apply(tx, signal)
          if (!await options.authorize(tx, identity, signal)) throw denied
          signal.throwIfAborted()
          return value
        } catch (error) {
          await mutation.rollback(tx)
          applied = false
          throw error
        }
      }, { signal })
      await mutation?.finalize().catch(() => {})
      try {
        if (receipt.replayed) await options.adapter.replayed?.(key.context.ownerId, key.operationId)
        else await options.adapter.published(key.context.ownerId, key.operationId)
      } catch { if (options.adapter.requirePublished) return { kind: 'unknown' } }
      return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
    } catch (error) {
      if (mutation && !applied) await mutation.finalize().catch(() => {})
      if (error === denied) return failure(denied.message)
      if (error instanceof UserSkillValidationError) return failure(error.message)
      if (error instanceof CoreError && ['conflict', 'invalid_request', 'not_found', 'forbidden'].includes(error.code)) return failure(error.message)
      return reconcile(action, input, { ...identity, roundId }, call)
    } finally {
      await options.adapter.release?.(key.context.ownerId, key.operationId).catch(() => {})
    }
  }
  return { execute, reconcile }
}
