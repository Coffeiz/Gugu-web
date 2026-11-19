import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { randomUUID } from 'node:crypto'
import { redactToolError } from '@gugu/core/agent'
import { dataContext } from '@gugu/core/contracts'
import type { RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import type { UserMemoryVectorRebuildResult } from '@gugu/core/byok/vector-rebuild'
import type { ScheduledTaskRedisCommands } from '../../scheduled-tasks/run/lease.js'

export interface EmbeddingRebuildStatusOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 available?:()=>boolean
 read(ownerId:string):Promise<unknown>
}

export function registerEmbeddingRebuildStatusRoute(app:FastifyInstance,options:EmbeddingRebuildStatusOptions):void{
 app.get('/api/v1/byok/embedding-rebuild/status',{preHandler:options.requireUser},(request,reply)=>{
  if(options.available && !options.available()) return reply.code(503).send({detail:'重建状态服务不可用'})
  return options.read(options.ownerIdFromRequest(request))
 })
}

const statusTtlSeconds = 3600

const lockTtlSeconds = 3600

const ownerKey = (rawOwnerId: string) => `emb:rebuild:user:${dataContext(rawOwnerId).ownerId}`

export interface UserEmbeddingRebuildState {
  available(): boolean
  read(ownerId: string): Promise<unknown>
  acquire(ownerId: string, token: string): Promise<boolean>
  write(ownerId: string, value: unknown): Promise<void>
  release(ownerId: string, token: string): Promise<void>
}

/** Python Worker 共用 owner 状态键；独立 NX 租约避免同 owner 并发启动。 */
export function createRedisUserEmbeddingRebuildState(redis: ScheduledTaskRedisCommands | null): UserEmbeddingRebuildState {
  return {
    available: () => redis !== null,
    async read(ownerId) {
      if (!redis) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      const key = ownerKey(ownerId)
      const value = await redis.eval("return redis.call('GET',KEYS[1])", 1, key)
      if (typeof value !== 'string') return { status: 'idle' }
      try { return JSON.parse(value) as unknown } catch { return { status: 'idle' } }
    },
    async acquire(ownerId, token) {
      if (!redis) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      return await redis.set(`${ownerKey(ownerId)}:lock`, token, 'EX', String(lockTtlSeconds), 'NX') === 'OK'
    },
    async write(ownerId, value) {
      if (!redis) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      await redis.set(ownerKey(ownerId), JSON.stringify(value), 'EX', String(statusTtlSeconds))
    },
    async release(ownerId, token) {
      if (!redis) return
      await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, `${ownerKey(ownerId)}:lock`, token)
    },
  }
}

export interface UserEmbeddingRebuildRuntimeOptions {
  state: UserEmbeddingRebuildState
  resolve(ownerId: string): Promise<RagQueryEmbeddingSettings | null>
  rebuild(ownerId: string, settings: RagQueryEmbeddingSettings, signal: AbortSignal): Promise<UserMemoryVectorRebuildResult>
  now(): number
}

export function createUserEmbeddingRebuildRuntime(options: UserEmbeddingRebuildRuntimeOptions) {
  const tasks = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  const writeState = (ownerId: string, status: Record<string, unknown>) => options.state.write(ownerId, { ...status, ts: options.now() / 1000 })

  async function execute(ownerId: string, token: string, settings: RagQueryEmbeddingSettings, controller: AbortController): Promise<void> {
    try {
      const result = await options.rebuild(ownerId, settings, controller.signal)
      await writeState(ownerId, {
        status: result.failedUsers || result.ragIndexFailed ? 'error' : 'done',
        pattern_vectors: result.patternVectors,
        memory_vectors: result.memoryVectors,
        with_patterns: result.withPatterns,
        failed_users: result.failedUsers,
        message: `重建完成：pattern ${result.patternVectors} 条，memory ${result.memoryVectors} 块${result.ragIndexFailed ? '；RAG 索引失败' : ''}`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Embedding 重建失败'
      await writeState(ownerId, { status: 'error', message: redactToolError(message).slice(0, 100) }).catch(() => undefined)
    } finally {
      controllers.delete(controller)
      await options.state.release(ownerId, token).catch(() => undefined)
    }
  }

  return {
    async start(rawOwnerId: string): Promise<{ ok: boolean; message: string; status?: unknown }> {
      const ownerId = dataContext(rawOwnerId).ownerId
      if (!options.state.available()) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      let settings: RagQueryEmbeddingSettings | null
      try { settings = await options.resolve(ownerId) } catch { settings = null }
      if (!settings) return { ok: false, message: '请先配置并启用 Embedding 凭据再重建' }

      const token = randomUUID()
      if (!await options.state.acquire(ownerId, token)) {
        return { ok: false, message: '已有重建任务在跑', status: await options.state.read(ownerId) }
      }
      try {
        await writeState(ownerId, { status: 'running' })
      } catch (error) {
        await options.state.release(ownerId, token).catch(() => undefined)
        throw error
      }
      const controller = new AbortController()
      controllers.add(controller)
      const task = execute(ownerId, token, settings, controller)
      tasks.add(task)
      void task.finally(() => tasks.delete(task))
      return { ok: true, message: '重建已启动' }
    },
    async close(): Promise<void> {
      for (const controller of controllers) controller.abort(new Error('Embedding 重建 Worker 已停止'))
      await Promise.allSettled([...tasks])
    },
  }
}

export interface EmbeddingRebuildRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  state: Pick<UserEmbeddingRebuildState, 'available'>
  canStart(): boolean
  start(ownerId: string): Promise<{ ok: boolean; message: string; status?: unknown }>
}

export function registerEmbeddingRebuildRoute(app: FastifyInstance, options: EmbeddingRebuildRouteOptions): void {
  app.post('/api/v1/byok/embedding-rebuild', { preHandler: options.requireUser }, async (request, reply) => {
    if (!options.state.available()) return reply.code(503).send({ detail: '重建状态服务不可用' })
    if (!options.canStart()) return reply.code(503).send({ detail: 'Node RAG Worker 未就绪' })
    return options.start(options.ownerIdFromRequest(request))
  })
}
