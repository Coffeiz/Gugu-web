import { randomUUID } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { dataContext } from '@gugu/core/contracts'
import type { ScheduledTaskRedisCommands } from '../scheduled-tasks/persistence/redis-lease.js'

const statusKey = 'rag:index-rebuild'
const lockKey = 'rag:index-rebuild:node-lock'
const lockTtlSeconds = 86_400
const statusTtlSeconds = 3_600
const sourceTimeoutMs = 15 * 60_000

export interface AdminIndexRebuildState {
  available(): boolean
  read(): Promise<unknown>
  acquire(token: string): Promise<boolean>
  write(value: unknown): Promise<void>
  release(token: string): Promise<void>
}

/** 管理任务继续使用 Python 共用状态键，Node 单独租约避免重复批次。 */
export function createRedisAdminIndexRebuildState(redis: ScheduledTaskRedisCommands | null): AdminIndexRebuildState {
  return {
    available: () => redis !== null,
    async read() {
      if (!redis) throw Object.assign(new Error('索引状态服务不可用'), { statusCode: 503 })
      const value = await redis.eval("return redis.call('GET',KEYS[1])", 1, statusKey)
      if (typeof value !== 'string') return { status: 'idle' }
      try { return JSON.parse(value) as unknown } catch { return { status: 'idle' } }
    },
    async acquire(token) {
      if (!redis) throw Object.assign(new Error('索引状态服务不可用'), { statusCode: 503 })
      return await redis.set(lockKey, token, 'EX', String(lockTtlSeconds), 'NX') === 'OK'
    },
    async write(value) {
      if (!redis) throw Object.assign(new Error('索引状态服务不可用'), { statusCode: 503 })
      await redis.set(statusKey, JSON.stringify(value), 'EX', String(statusTtlSeconds))
    },
    async release(token) {
      if (!redis) return
      await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, lockKey, token)
    },
  }
}

export interface AdminIndexRebuildRuntimeOptions {
  state: AdminIndexRebuildState
  listOwners(): Promise<readonly string[]>
  sourceTypes: readonly string[]
  enqueue(ownerId: string, sourceType: string): Promise<void>
  readProgress(ownerId: string, sourceType: string): Promise<{ generation: number; completedGeneration: number; status: string } | null>
  countDocuments(ownerId: string, rebuiltSources: readonly string[]): Promise<number>
  wait(signal: AbortSignal): Promise<void>
  now(): number
  sourceTimeoutMs?: number
}

export interface AdminIndexRebuildResult {
  ok: boolean
  message: string
  total?: number
  status?: unknown
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 将管理任务串接到真实持久 RAG job，逐来源等待 Worker 收据后再汇总。 */
export function createAdminIndexRebuildRuntime(options: AdminIndexRebuildRuntimeOptions) {
  const timeoutMs = options.sourceTimeoutMs ?? sourceTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new RangeError('索引重建等待时限无效')
  let task: Promise<void> | null = null
  let controller: AbortController | null = null
  let closed = false

  async function writeStatus(status: Record<string, unknown>): Promise<void> {
    await options.state.write({ ...status, ts: options.now() / 1_000 })
  }

  async function waitForSource(ownerId: string, sourceType: string, signal: AbortSignal): Promise<void> {
    const deadline = options.now() + timeoutMs
    while (true) {
      signal.throwIfAborted()
      const progress = await options.readProgress(ownerId, sourceType)
      if (!progress) throw new Error('RAG 索引任务状态丢失')
      if (progress.status === 'ready' && progress.completedGeneration >= progress.generation) return
      if (options.now() >= deadline) throw new Error('RAG 索引重建等待超时')
      await options.wait(signal)
    }
  }

  async function run(ownerIds: readonly string[], token: string, signal: AbortSignal): Promise<void> {
    let done = 0, documents = 0, failedUsers = 0, failedSources = 0
    try {
      for (const ownerId of ownerIds) {
        signal.throwIfAborted()
        let ownerFailed = false
        const rebuiltSources: string[] = []
        for (const sourceType of options.sourceTypes) {
          signal.throwIfAborted()
          try {
            await options.enqueue(ownerId, sourceType)
            await waitForSource(ownerId, sourceType, signal)
            rebuiltSources.push(sourceType)
          } catch {
            signal.throwIfAborted()
            ownerFailed = true
            failedSources += 1
          }
        }
        try { documents += Math.max(0, Math.trunc(await options.countDocuments(ownerId, rebuiltSources))) }
        catch { ownerFailed = true }
        if (ownerFailed) failedUsers += 1
        done += 1
        await writeStatus({ status: 'running', done, total: ownerIds.length, documents, failed_users: failedUsers, failed_sources: failedSources })
      }
      const status = failedUsers ? 'error' : 'done'
      await writeStatus({
        status, done, total: ownerIds.length, documents, failed_users: failedUsers, failed_sources: failedSources,
        message: `索引重建完成：${documents} 条文档${failedUsers ? `；失败用户 ${failedUsers} 个，失败来源 ${failedSources} 个` : ''}`,
      })
    } catch {
      const message = signal.aborted ? '服务关闭，索引重建任务中断' : '索引重建失败，请查看服务端诊断日志'
      await writeStatus({ status: 'error', done, total: ownerIds.length, documents, failed_users: failedUsers, failed_sources: failedSources, message }).catch(() => undefined)
    } finally {
      if (controller?.signal === signal) controller = null
      await options.state.release(token).catch(() => undefined)
    }
  }

  return {
    async start(): Promise<AdminIndexRebuildResult> {
      if (closed) throw Object.assign(new Error('索引重建服务已关闭'), { statusCode: 503 })
      if (!options.state.available()) throw Object.assign(new Error('索引状态服务不可用'), { statusCode: 503 })
      const token = randomUUID()
      if (!await options.state.acquire(token)) return { ok: false, message: '已有索引重建任务在跑', status: await options.state.read() }
      let transferred = false
      try {
        const current = object(await options.state.read())
        if (current.status === 'running') return { ok: false, message: '已有索引重建任务在跑', status: current }
        const ownerIds = [...new Set((await options.listOwners()).map(value => dataContext(value).ownerId))]
        await writeStatus({ status: 'running', done: 0, total: ownerIds.length, documents: 0, failed_users: 0, failed_sources: 0 })
        const active = new AbortController()
        controller = active
        const running = run(ownerIds, token, active.signal)
        task = running
        transferred = true
        void running.finally(() => { if (task === running) task = null })
        return { ok: true, message: `索引重建已启动，共 ${ownerIds.length} 个用户`, total: ownerIds.length }
      } finally {
        if (!transferred) await options.state.release(token).catch(() => undefined)
      }
    },
    async close(): Promise<void> {
      closed = true
      controller?.abort(new Error('Admin RAG 重建服务已停止'))
      await task?.catch(() => undefined)
    },
  }
}

export interface AdminIndexRebuildRouteOptions {
  requireAdmin: preHandlerHookHandler
  available(): boolean
  canStart(): boolean
  runtime: Pick<ReturnType<typeof createAdminIndexRebuildRuntime>, 'start' | 'close'>
}

export function registerAdminIndexRebuildRoute(app: FastifyInstance, options: AdminIndexRebuildRouteOptions): void {
  app.post('/api/v1/admin/config/index-rebuild', { preHandler: options.requireAdmin }, async (_request, reply) => {
    if (!options.available()) return reply.code(503).send({ detail: '维护状态服务不可用' })
    if (!options.canStart()) return reply.code(503).send({ detail: '索引重建 Worker 未就绪' })
    try { return await options.runtime.start() }
    catch { return reply.code(503).send({ detail: '索引重建暂不可用' }) }
  })
  app.addHook('onClose', async () => options.runtime.close())
}
