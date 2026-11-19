import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { randomUUID } from 'node:crypto'

import { dataContext } from '@gugu/core/contracts'

import type { RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'

import { redactToolError } from '@gugu/core/agent'

import type { AdminIndexRedisCommands } from './index-rebuild.js'

export interface AdminEmbeddingRebuildRouteOptions {
  requireAdmin: preHandlerHookHandler
  state: Pick<AdminEmbeddingRebuildState, 'available'>
  canStart(): boolean
  runtime: Pick<ReturnType<typeof createAdminEmbeddingRebuildRuntime>, 'start' | 'close'>
}

export function registerAdminEmbeddingRebuildRoutes(app: FastifyInstance, options: AdminEmbeddingRebuildRouteOptions): void {
  app.post('/api/v1/admin/config/embedding-rebuild', { preHandler: options.requireAdmin }, async (_request, reply) => {
    if (!options.state.available()) return reply.code(503).send({ detail: '重建状态服务不可用' })
    if (!options.canStart()) return reply.code(503).send({ detail: 'Node RAG Worker 未就绪' })
    try { return await options.runtime.start() }
    catch { return reply.code(503).send({ detail: 'Embedding 重建暂不可用' }) }
  })
  app.addHook('onClose', async () => options.runtime.close())
}

export interface AdminEmbeddingRebuildStatusOptions{
 requireAdmin:preHandlerHookHandler
 available:()=>boolean
 read():Promise<unknown>
}
export function registerAdminEmbeddingRebuildStatusRoute(app:FastifyInstance,options:AdminEmbeddingRebuildStatusOptions):void{
 app.get('/api/v1/admin/config/embedding-rebuild/status',{preHandler:options.requireAdmin},(_request,reply)=>{
  if(!options.available())return reply.code(503).send({detail:'重建状态服务不可用'})
  return options.read()
 })
}

const ownerTimeoutMs = 15 * 60_000

export interface AdminEmbeddingRebuildState {
  available(): boolean
  read(): Promise<unknown>
  acquire(token: string): Promise<boolean>
  renew(token: string): Promise<boolean>
  write(value: unknown): Promise<void>
  release(token: string): Promise<void>
}

export interface AdminEmbeddingRebuildResult {
  ok: boolean
  message: string
  total?: number
  status?: unknown
}

export interface AdminEmbeddingRebuildRuntimeOptions {
  state: AdminEmbeddingRebuildState
  listOwners(): Promise<readonly string[]>
  resolve(ownerId: string): Promise<RagQueryEmbeddingSettings | null>
  startOwner(ownerId: string): Promise<{ ok: boolean; message: string; status?: unknown }>
  readOwner(ownerId: string): Promise<unknown>
  wait(signal: AbortSignal): Promise<void>
  now(): number
  ownerTimeoutMs?: number
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function numeric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function settingsTag(settings: RagQueryEmbeddingSettings): string {
  return `${settings.provider}:${settings.model}:${settings.dimensions || 'default'}`
}

/** 复用逐 owner 的真实 BYOK 重建器和 RAG Worker，只负责编排与汇总管理员批次。 */
export function createAdminEmbeddingRebuildRuntime(options: AdminEmbeddingRebuildRuntimeOptions) {
  const timeoutMs = options.ownerTimeoutMs ?? ownerTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new RangeError('重建等待时限无效')
  let task: Promise<void> | null = null
  let controller: AbortController | null = null
  let closed = false

  async function writeStatus(status: Record<string, unknown>): Promise<void> {
    await options.state.write({ ...status, ts: options.now() / 1_000 })
  }

  async function waitForOwner(ownerId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const deadline = options.now() + timeoutMs
    while (true) {
      signal.throwIfAborted()
      const status = object(await options.readOwner(ownerId))
      if (status.status === 'done' || status.status === 'error') return status
      if (status.status !== 'running') throw new Error('用户向量重建状态丢失')
      if (options.now() >= deadline) throw new Error('用户向量重建等待超时')
      await options.wait(signal)
    }
  }

  async function run(ownerIds: readonly string[], settings: ReadonlyMap<string, RagQueryEmbeddingSettings>, token: string, signal: AbortSignal): Promise<void> {
    let done = 0, patternVectors = 0, memoryVectors = 0, withPatterns = 0, failedUsers = 0, ragFailedUsers = 0
    let tag = ''
    try {
      for (const ownerId of ownerIds) {
        signal.throwIfAborted()
        const embedding = settings.get(ownerId)
        if (!embedding) {
          failedUsers += 1
          done += 1
          await writeStatus({ status: 'running', done, total: ownerIds.length, pattern_vectors: patternVectors, memory_vectors: memoryVectors, with_patterns: withPatterns, failed_users: failedUsers, rag_failed_users: ragFailedUsers, tag })
          continue
        }
        tag = settingsTag(embedding)
        try {
          const started = await options.startOwner(ownerId)
          let outcome: Record<string, unknown>
          if (started.ok) outcome = await waitForOwner(ownerId, signal)
          else {
            const rejectedState = object(started.status)
            if (rejectedState.status !== 'running') throw new Error('用户重建无法启动')
            // 另一个调用方已持有 owner 租约；等待其完成，避免并发覆盖同一组向量文件。
            outcome = await waitForOwner(ownerId, signal)
          }
          if (outcome.status === 'error') {
            const vectorFailures = numeric(outcome.failed_users)
            const ragFailed = String(outcome.message || '').includes('RAG 索引失败')
            failedUsers += vectorFailures || (ragFailed ? 0 : 1)
            if (ragFailed) ragFailedUsers += 1
          } else {
            patternVectors += numeric(outcome.pattern_vectors)
            memoryVectors += numeric(outcome.memory_vectors)
            withPatterns += numeric(outcome.with_patterns)
            ragFailedUsers += numeric(outcome.rag_failed_users)
          }
        } catch {
          signal.throwIfAborted()
          failedUsers += 1
        }
        done += 1
        await writeStatus({ status: 'running', done, total: ownerIds.length, pattern_vectors: patternVectors, memory_vectors: memoryVectors, with_patterns: withPatterns, failed_users: failedUsers, rag_failed_users: ragFailedUsers, tag })
      }
      const status = failedUsers || ragFailedUsers ? 'error' : 'done'
      await writeStatus({
        status, done, total: ownerIds.length, pattern_vectors: patternVectors, memory_vectors: memoryVectors,
        with_patterns: withPatterns, failed_users: failedUsers, rag_failed_users: ragFailedUsers,
        message: `重建完成：pattern ${patternVectors} 条，memory ${memoryVectors} 块${failedUsers ? `；失败用户 ${failedUsers} 个` : ''}${ragFailedUsers ? `；RAG 索引失败 ${ragFailedUsers} 个` : ''}`,
        tag,
      })
    } catch {
      const reason = signal.aborted ? '服务关闭，重建任务中断' : '重建任务失败，请查看服务端诊断日志'
      await writeStatus({ status: 'error', done, total: ownerIds.length, pattern_vectors: patternVectors, memory_vectors: memoryVectors, with_patterns: withPatterns, failed_users: failedUsers, rag_failed_users: ragFailedUsers, message: reason, tag }).catch(() => undefined)
    } finally {
      if (controller?.signal === signal) controller = null
      await options.state.release(token).catch(() => undefined)
    }
  }

  return {
    async start(): Promise<AdminEmbeddingRebuildResult> {
      if (closed) throw Object.assign(new Error('重建服务已关闭'), { statusCode: 503 })
      if (!options.state.available()) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      const token = randomUUID()
      if (!await options.state.acquire(token)) return { ok: false, message: '已有重建任务在跑', status: await options.state.read() }
      let ownershipTransferred = false
      try {
        const current = object(await options.state.read())
        if (current.status === 'running') return { ok: false, message: '已有重建任务在跑', status: current }
        const ownerIds = [...new Set((await options.listOwners()).map(value => dataContext(value).ownerId))]
        const settings = new Map<string, RagQueryEmbeddingSettings>()
        for (const ownerId of ownerIds) {
          try { const value = await options.resolve(ownerId); if (value) settings.set(ownerId, value) } catch { /* 将具体用户计入失败，不泄露底层错误。 */ }
        }
        if (!settings.size) return { ok: false, message: '请先启用并配置 embedding 模型（平台配置或用户 BYOK 凭据至少其一）' }
        await writeStatus({ status: 'running', done: 0, total: ownerIds.length, pattern_vectors: 0, memory_vectors: 0, with_patterns: 0, failed_users: 0, rag_failed_users: 0, tag: '' })
        const active = new AbortController()
        controller = active
        const running = run(ownerIds, settings, token, active.signal)
        task = running
        ownershipTransferred = true
        void running.finally(() => { if (task === running) task = null })
        return { ok: true, message: `重建已启动，共 ${ownerIds.length} 个用户`, total: ownerIds.length }
      } catch (error) {
        throw error
      } finally {
        if (!ownershipTransferred) await options.state.release(token).catch(() => undefined)
      }
    },
    async close(): Promise<void> {
      closed = true
      controller?.abort(new Error('Embedding 批量重建服务已停止'))
      await task?.catch(() => undefined)
    },
  }
}

/** 读取平台重建状态；正常进度完整保留，异常终态消息不可透出路径或密钥。 */
export function createAdminEmbeddingRebuildStatusReader(readRaw:()=>Promise<string|null>){
 return async():Promise<unknown>=>{
  const raw=await readRaw()
  if(!raw)return {status:'idle'}
  let value:unknown
  try{value=JSON.parse(raw)}catch{return {status:'idle'}}
  if(value&&typeof value==='object'&&!Array.isArray(value)){
   const state=value as Record<string,unknown>
   if(state.status==='error'&&typeof state.message==='string')return {...state,message:redactToolError(state.message)}
  }
  return value
 }
}

const statusKey = 'emb:rebuild'
const lockKey = 'emb:rebuild:node-lock'
const lockTtlSeconds = 86_400
const statusTtlSeconds = 3_600

/** 管理员批量任务与 Python 共用状态键；独立租约防止 Node 管理员重复启动。 */
export function createRedisAdminEmbeddingRebuildState(redis: AdminIndexRedisCommands | null): AdminEmbeddingRebuildState {
  return {
    available: () => redis !== null,
    async read() {
      if (!redis) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      const value = await redis.eval("return redis.call('GET',KEYS[1])", 1, statusKey)
      if (typeof value !== 'string') return { status: 'idle' }
      try { return JSON.parse(value) as unknown } catch { return { status: 'idle' } }
    },
    async acquire(token) {
      if (!redis) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      return await redis.set(lockKey, token, 'EX', String(lockTtlSeconds), 'NX') === 'OK'
    },
    async renew(token) {
      if (!redis) return false
      const result = await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) else return 0 end", 1, lockKey, token, String(lockTtlSeconds))
      return Number(result) === 1
    },
    async write(value) {
      if (!redis) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      await redis.set(statusKey, JSON.stringify(value), 'EX', String(statusTtlSeconds))
    },
    async release(token) {
      if (!redis) return
      await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, lockKey, token)
    },
  }
}
