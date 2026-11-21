import { createHash, randomBytes } from 'node:crypto'
import type { Transaction } from 'kysely'
import { dataContext } from '@gugu/core/contracts'
import { enqueueAgentRagRebuildInTransaction, invalidateAgentMemoryRagInTransaction } from '@gugu/core/agent/rag'
import { ownerReflectionFiles,
  planOwnerReflectionEdits, type OwnerReflectionFile, type OwnerReflectionFiles } from '@gugu/core/agent/memory/owner-reflection-edits'
import { stableJson } from '@gugu/core/agent'
import type { Database, SqlDataRuntime } from '@gugu/core/data'
import { openLocalFile, removeLocalTree, writeLocalFile } from '@gugu/fs/node'
import { lockOwnerMemory, lockOwnerMemoryArchive } from '../../../../shared/owner-memory-lock.js'

export type OwnerReflectionBatch = { ownerId: string; sessionId: string; batchId: string; isCurrent(): Promise<boolean> }
type FilePlan = { name: OwnerReflectionFile; before: string; after: string }
type Plan = { files: FilePlan[]; archiveRevision: string | null }
type Publication = 'applied' | 'superseded'
class StaleReflectionSnapshot extends Error {}
const missingPlan = new Error('反思批次无发布计划')
const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

/** 文件暂存留在授权根。数据库收据只保留版本摘要，可恢复部分发布或未知提交。 */
export function createLocalOwnerReflectionWriter(options: {
  core: SqlDataRuntime
  storageRoot: string
  authorize(tx: Transaction<Database>, batch: OwnerReflectionBatch, signal: AbortSignal): Promise<boolean>
}) {
  const { core, storageRoot } = options
  if (core.backend !== 'postgres' || !core.receipts) throw new Error('反思发布需要 PostgreSQL 持久收据')

  function scope(batch: OwnerReflectionBatch) {
    const context = dataContext(batch.ownerId)
    if (!/^[a-f0-9]{64}$/u.test(batch.batchId) || !/^[1-9]\d*$/u.test(batch.sessionId) || !Number.isSafeInteger(Number(batch.sessionId)))
      throw new TypeError('反思批次身份无效')
    const base = `${context.ownerId}/.agent/memories/`, staging = `${base}.reflection/${batch.batchId}`
    const coordinates = (phase: 'plan' | 'finish') => {
      const method = `agent.memory.reflection.${phase}`
      const key = hash([method, context.ownerId, batch.sessionId, batch.batchId])
      const id = `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`
      return { method, id }
    }
    return { context, base, staging, coordinates, fingerprint: { sessionId: batch.sessionId, batchId: batch.batchId } }
  }

  async function read(key: string): Promise<string | null> {
    const file = await openLocalFile(storageRoot, key)
    if (!file) return null
    try {
      if (file.size > 50_000_000) throw new Error('反思记忆档案超出读取限制')
      const bytes = await file.handle.readFile()
      if (bytes.length > 50_000_000) throw new Error('反思记忆档案超出读取限制')
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } finally { await file.handle.close() }
  }

  async function readFiles(base: string): Promise<OwnerReflectionFiles> {
    return Object.fromEntries(await Promise.all(ownerReflectionFiles.map(async name =>
      [name, await read(base + name)] as const))) as OwnerReflectionFiles
  }

  async function authorize(tx: Transaction<Database>, batch: OwnerReflectionBatch, owner: string, signal: AbortSignal) {
    await lockOwnerMemory(tx, owner)
    signal.throwIfAborted()
    const archive = await lockOwnerMemoryArchive(tx, owner)
    if (!archive || archive.busy || !await options.authorize(tx, batch, signal) || !await batch.isCurrent())
      throw new Error('反思发布授权暂不可用')
    signal.throwIfAborted()
    return archive.revision
  }

  async function finish(batch: OwnerReflectionBatch, plan: Plan, signal: AbortSignal): Promise<Publication> {
    const { context, base, staging, coordinates, fingerprint } = scope(batch)
    const { method, id } = coordinates('finish')
    const receipt = await core.operationWithTransaction<Publication>(context, id, method, fingerprint, async tx => {
      const revision = await authorize(tx, batch, context.ownerId, signal)
      const queue = () => enqueueAgentRagRebuildInTransaction(tx, core.backend, context.ownerId, 'memory')
      const superseded = async (): Promise<Publication> => {
        if (plan.files.length) await queue()
        return 'superseded'
      }
      if (revision !== plan.archiveRevision) return superseded()
      const pending: Array<{ name: OwnerReflectionFile; text: string }> = []
      for (const file of plan.files) {
        const current = hash(await read(base + file.name))
        if (current === file.after) continue
        if (current !== file.before) return superseded()
        const text = await read(staging + '/' + file.name)
        if (text === null || hash(text) !== file.after) throw new Error('反思暂存文件已变化')
        pending.push({ name: file.name, text })
      }
      signal.throwIfAborted()
      for (const file of pending) await writeLocalFile(storageRoot, base + file.name, file.text)
      if (plan.files.length) await queue()
      return 'applied'
    })
    await removeLocalTree(storageRoot, staging).catch(() => undefined)
    return receipt.result
  }

  return {
    async snapshot(batch: OwnerReflectionBatch, signal: AbortSignal) {
      const { context, base } = scope(batch)
      return core.db.transaction().execute(async tx => {
        const revision = await authorize(tx, batch, context.ownerId, signal)
        const files = await readFiles(base)
        signal.throwIfAborted()
        return { files, version: hash([revision, files]) }
      })
    },
    async publish(batch: OwnerReflectionBatch, version: string, output: unknown, time: { now: number; date: string }, signal: AbortSignal) {
      const { context, base, staging, coordinates, fingerprint } = scope(batch)
      const { method, id } = coordinates('plan')
      try {
        const receipt = await core.operationWithTransaction<Plan>(context, id, method, fingerprint, async tx => {
          const archiveRevision = await authorize(tx, batch, context.ownerId, signal)
          const current = await readFiles(base)
          if (hash([archiveRevision, current]) !== version) throw new StaleReflectionSnapshot()
          const changes = planOwnerReflectionEdits(current, output, time.now, time.date, () => randomBytes(3).toString('hex'))
          const files: FilePlan[] = []
          for (const name of ownerReflectionFiles) {
            const text = changes[name]
            if (text === undefined) continue
            signal.throwIfAborted()
            await writeLocalFile(storageRoot, staging + '/' + name, text)
            files.push({ name, before: hash(current[name]), after: hash(text) })
          }
          if (files.length) await invalidateAgentMemoryRagInTransaction(tx, core.backend, context.ownerId)
          return { files, archiveRevision }
        }, { signal })
        return finish(batch, receipt.result, signal)
      } catch (error) {
        if (error instanceof StaleReflectionSnapshot) return 'stale' as const
        throw error
      }
    },
    async reconcile(batch: OwnerReflectionBatch, signal: AbortSignal): Promise<Publication | null> {
      const { context, coordinates, fingerprint } = scope(batch)
      const { method, id } = coordinates('plan')
      try {
        const receipt = await core.operationWithTransaction<Plan>(context, id, method, fingerprint, async () => { throw missingPlan })
        return finish(batch, receipt.result, signal)
      } catch (error) {
        if (error === missingPlan) return null
        throw error
      }
    },
  }
}
