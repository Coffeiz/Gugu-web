import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { CoreError } from '@gugu/core/contracts'

import { randomUUID } from 'node:crypto'

import { z } from 'zod'


import { planAccountMemoryCleanup,type AccountMemoryCleanupPlan,type readAccountMemoryCleanupSource } from '@gugu/core/memory/account-cleanup-preview'

import type { ProviderConfig } from '@gugu/core/providers'

export function registerAccountMemoryCleanupRoutes(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  runtime: ReturnType<typeof createAccountMemoryCleanupRuntime>
}) {
  app.post('/api/v1/admin/config/memory-cleanup/preview', { preHandler: options.requireAdmin }, async (_request, reply) => {
    if (!options.runtime.available()) return reply.code(503).send({ detail: '记忆索引重建服务不可用' })
    return options.runtime.preview()
  })
  app.post('/api/v1/admin/config/memory-cleanup/apply', { preHandler: options.requireAdmin }, async (_request, reply) => {
    if (!options.runtime.available()) return reply.code(503).send({ detail: '记忆索引重建服务不可用' })
    try { return await options.runtime.apply() }
    catch (error) {
      if (error instanceof CoreError && error.code === 'invalid_request') return reply.code(400).send({ detail: error.message })
      throw error
    }
  })
}

export interface AccountMemoryValues { get(key: string): Promise<string | null> }
export interface AccountMemoryRedis {
  exists(key: string): Promise<unknown>
  set(key: string, value: string, ...options: string[]): Promise<unknown>
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
}
export interface AccountMemoryStorage {
  read(ownerId: string): Promise<ReturnType<typeof readAccountMemoryCleanupSource>>
  apply(ownerId: string, operationId: string, plan: AccountMemoryCleanupPlan): Promise<{ touched: boolean; removed: number; moved: number; profileEvents: number; daily: number }>
}

const stateKey = 'mem_cleanup:node:plan'
const leaseKey = 'mem_cleanup:node:lock'
const expirySeconds = 3600
const leaseSeconds = 90
const count = z.int().nonnegative()
const planSchema = z.object({
  removed_ids: z.array(z.string()), removed_texts: z.array(z.string()),
  moved_ids: z.array(z.string()), moved_texts: z.array(z.string()),
  profile_event_migrated: count, profile_event_texts: z.array(z.string()), daily_migrated: count, daily_texts: z.array(z.string()),
  total: count, source_revision: z.string().regex(/^[0-9a-f]{64}$/u), batch_count: count,
})
const stateSchema = z.object({
  status: z.enum(['running', 'done', 'stale', 'idle']), operation: z.uuid(),
  applying: z.boolean().optional(), done: count, total: count, ts: z.number(),
  total_batches: count, completed_batches: count, failed_users: count,
  plan_ready: z.boolean(), plan: z.record(z.uuid(), planSchema),
})
type State = z.infer<typeof stateSchema>

function publicState({ operation: _operation, applying: _applying, ...state }: State) {
  if (state.status === 'idle') return { status: 'idle' }
  if (state.status === 'stale') return { status: 'stale', done: state.done, total: state.total, message: '上次预览已过期，请重新生成' }
  return state
}

function openRedisJob(values: AccountMemoryValues, redis: AccountMemoryRedis) {
  return {
    async locked() { return await redis.exists(leaseKey) === '1' },
    async read(): Promise<State | null> {
      const raw = await values.get(stateKey)
      if (!raw) return null
      const state = stateSchema.safeParse(JSON.parse(raw))
      if (!state.success) throw new CoreError('conflict', '记忆维护预览状态损坏')
      return state.data
    },
    async claim() {
      const token = randomUUID()
      if (await redis.set(leaseKey, token, 'NX', 'EX', String(leaseSeconds)) !== 'OK') return null
      let lost = false
      let renewing: Promise<void> = Promise.resolve()
      const renewScript = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) end return 0"
      const assertLease = () => {
        renewing = renewing.then(async () => {
          if (lost) return
          try { lost = await redis.eval(renewScript, 1, leaseKey, token, String(leaseSeconds)) !== '1' }
          catch { lost = true }
        })
        return renewing.then(() => { if (lost) throw new CoreError('conflict', '记忆维护执行租约已失效') })
      }
      const timer = setInterval(() => { void assertLease().catch(() => undefined) }, 20_000)
      timer.unref()
      const writeScript = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end if ARGV[3]=='0' then redis.call('SET',KEYS[2],ARGV[2]) else redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3]) end if ARGV[4]=='1' then redis.call('DEL',KEYS[1]) end return 1"
      const releaseScript = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0"
      return {
        assertLease,
        async write(state: State, finish = false) {
          // 执行中的计划必须保留，进程中断后由下一次确认接续原操作。
          const stored = await redis.eval(writeScript, 2, leaseKey, stateKey, token, JSON.stringify(state),
            state.applying ? '0' : String(expirySeconds), finish ? '1' : '0')
          if (stored !== '1') throw new CoreError('conflict', '记忆维护执行租约已失效')
        },
        async release() {
          clearInterval(timer)
          await renewing
          await redis.eval(releaseScript, 1, leaseKey, token).catch(() => undefined)
        },
      }
    },
  }
}

export function createAccountMemoryCleanupRuntime(options: {
  values: AccountMemoryValues
  redis: AccountMemoryRedis
  listOwners(): Promise<string[]>
  available(): boolean
  storage: AccountMemoryStorage
  model(): ProviderConfig
  complete(input: { config: ProviderConfig; system: string; prompt: string; maxTokens: number }): Promise<unknown>
  refreshVectors?(owner: string, changed: { pattern: boolean; memory: boolean }): Promise<void>
  now?: () => number
}) {
  const jobs = openRedisJob(options.values, options.redis)
  const now = options.now ?? (() => Date.now() / 1000)
  let background: Promise<void> | undefined
  type Job = NonNullable<Awaited<ReturnType<typeof jobs.claim>>>
  async function runPreview(job: Job, state: State, owners: readonly string[]) {
    const config = options.model()
    for (const owner of owners) {
      await job.assertLease()
      try {
        const result = await planAccountMemoryCleanup({
          ...await options.storage.read(owner), modelBudget: config,
          async complete(request) {
            await job.assertLease()
            try { return await options.complete({ ...request, config }) }
            catch (error) {
              if (error instanceof SyntaxError || error instanceof TypeError && error.message === '模型预览输出不是有效 JSON 对象')
                return null
              throw error
            }
          },
        })
        state.total_batches += result.totalBatches
        state.completed_batches += result.completedBatches
        if (!result.ready) state.failed_users++
        if (result.plan) state.plan[owner] = result.plan
      } catch { state.failed_users++ }
      state.done++
      state.ts = now()
      await job.write(state)
    }
    await job.write({ ...state, status: 'done', ts: now(), plan_ready: state.failed_users === 0 }, true)
  }
  return {
    available: options.available,
    async status() {
      const state = await jobs.read()
      if (state?.status === 'running' && now() - state.ts >= 600 && !await jobs.locked())
        return publicState({ ...state, status: 'stale' })
      return state && publicState(state)
    },
    async preview() {
      const job = await jobs.claim()
      if (!job) {
        const state = await jobs.read()
        const message = state?.status === 'running' ? '已有清理预览在跑' : '已有记忆维护任务在跑'
        return { ok: false, message, status: state ? publicState(state) : { status: 'idle' } }
      }
      let handedOff = false
      try {
        const previous = await jobs.read()
        if (previous?.applying) return { ok: false, message: '已有清理在等待继续执行', status: publicState(previous) }
        const owners = await options.listOwners()
        const state: State = { status: 'running', operation: randomUUID(), done: 0, total: owners.length, ts: now(),
          total_batches: 0, completed_batches: 0, failed_users: 0, plan_ready: false, plan: {} }
        await job.write(state)
        handedOff = true
        background = runPreview(job, state, owners).catch(async () => {
          await job.write({ ...state, status: 'done', ts: now(), failed_users: state.failed_users + 1, plan_ready: false }, true).catch(() => undefined)
        }).finally(() => job.release())
        return { ok: true, message: `预览已启动，共 ${owners.length} 个用户`, total: owners.length }
      } finally {
        if (!handedOff) await job.release()
      }
    },
    async apply() {
      const job = await jobs.claim()
      if (!job) {
        if ((await jobs.read())?.status === 'running') throw new CoreError('invalid_request', '预览还没跑完，等它跑完再确认')
        throw new CoreError('conflict', '已有记忆维护任务在跑')
      }
      try {
        const state = await jobs.read()
        if (!state || state.status === 'idle') throw new CoreError('invalid_request', '没有可执行的清理预览，先跑一次预览')
        if (state.status === 'stale') throw new CoreError('conflict', '记忆维护预览已过期，源数据发生变化，请重新生成预览')
        if (state.status !== 'done') throw new CoreError('invalid_request', '预览还没跑完，等它跑完再确认')
        if (!state.plan_ready) throw new CoreError('invalid_request', '记忆维护预览包含失败用户，请重新生成预览')
        await job.write({ ...state, applying: true })
        const response = { ok: true, users_applied: 0, total_removed: 0, total_moved: 0,
          total_profile_events_migrated: 0, total_daily_migrated: 0 }
        for (const [owner, plan] of Object.entries(state.plan)) {
          await job.assertLease()
          try {
            const result = await options.storage.apply(owner, state.operation, plan)
            response.users_applied += Number(result.touched)
            response.total_removed += result.removed
            response.total_moved += result.moved
            response.total_profile_events_migrated += result.profileEvents
            response.total_daily_migrated += result.daily
            const changed = { pattern: result.removed + result.moved > 0, memory: result.profileEvents > 0 }
            if (result.touched && (changed.pattern || changed.memory) && options.refreshVectors) {
              await job.assertLease()
              await options.refreshVectors(owner, changed).catch(() => { console.warn('记忆维护后的向量补算失败') })
            }
          } catch (error) {
            if (error instanceof CoreError && (error.code === 'conflict' || error.code === 'not_found')) {
              await job.write({ ...state, status: 'stale', applying: false, plan_ready: false, plan: {} })
              if (error.code === 'not_found') throw new CoreError('conflict', '预览中的用户已不存在，请重新生成预览')
            }
            throw error
          }
        }
        await job.write({ ...state, status: 'idle', applying: false, plan_ready: false, plan: {} }, true)
        return response
      } finally { await job.release() }
    },
    async close() { await background },
  }
}
