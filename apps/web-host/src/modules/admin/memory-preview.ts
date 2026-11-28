import { createHash,randomUUID } from 'node:crypto'

import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { completeStandaloneText } from '@gugu/core/providers'

import type { ProviderConfig,ProviderDriverDependencies,ProviderTransport } from '@gugu/core/providers'

import { createNodeProviderTransport } from '@gugu/core/providers/node'


import { previewImMaintenanceScope } from '@gugu/core/im-memory-maintenance-preview'

import { resolveMaintenanceBudget } from '@gugu/core/im-memory-maintenance-batches'


import type { ImMaintenanceCursor,ImMaintenanceMessage } from '@gugu/core/im-memory-maintenance-source'

import { imMemoryMaintenanceScopeFileKey,IM_MEMORY_MODEL_PREVIEW_PLAN_KEY as planKey,IM_MEMORY_MODEL_PREVIEW_KEY as stateKey } from './memory-apply.js'

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function parseObjectOutput(text: string): Record<string, unknown> {
  let value = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value)
  if (fenced) value = fenced[1]!.trim()
  const first = value.indexOf('{'), last = value.lastIndexOf('}')
  if (first < 0 || last < first) throw new TypeError('模型预览输出不是有效 JSON 对象')
  const parsed: unknown = JSON.parse(value.slice(first, last + 1))
  if (!record(parsed)) throw new TypeError('模型预览输出不是有效 JSON 对象')
  return parsed
}

/** Host 从可信 AI 配置读取模型并使用受限 Node Transport；Core 负责 Provider 协议驱动。 */
export function createStandaloneImMemoryModelCaller(options: {
  readonly environment: NodeJS.ProcessEnv
  readonly createTransport?: (config: ProviderConfig) => ProviderTransport & { close?(): Promise<void> }
}) {
  return async (request: { system: string; prompt: string; maxTokens: number; config: ProviderConfig }): Promise<Record<string, unknown>> => {
    const config = request.config
    const provider = config.provider?.trim().toLowerCase()
    const transport = options.createTransport?.(config) ?? createNodeProviderTransport({
      allowLocal: provider === 'local' || provider === 'ollama', connectTimeoutMs: 10_000,
      writeTimeoutMs: 30_000, environment: () => options.environment,
    })
    const dependencies: ProviderDriverDependencies = {
      transport,
      digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    }
    try {
      const text = await completeStandaloneText({
        config, system: request.system, prompt: request.prompt, maxTokens: request.maxTokens, outputMode: 'json', thinking: 'disabled', exactMaxTokens: true,
        signal: new AbortController().signal,
        identity: { ownerId: 'im-maintenance', sessionId: randomUUID(), runId: randomUUID() },
      }, dependencies)
      return parseObjectOutput(text)
    } finally { await transport.close?.() }
  }
}

export function registerImMemoryMaintenancePreviewRoute(app: FastifyInstance, options: {
  readonly requireAdmin: preHandlerHookHandler
  start(): Promise<{ ok: true; total: number } | { ok: false; message: string; status: unknown }>
}): void {
  app.post('/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview', { preHandler: options.requireAdmin }, async (_request, reply) => {
    try { return await options.start() }
    catch (error) {
      if (error instanceof ImMemoryMaintenancePreviewError) return reply.code(error.statusCode).send({ detail: error.message })
      return reply.code(503).send({ detail: '模型预览暂不可用' })
    }
  })
}

export const IM_MEMORY_MODEL_PREVIEW_LOCK_KEY = 'im_memory:maintenance:model_preview:lock'
const TTL_SECONDS = 3600

type ValueStore = {
  get(key: string): Promise<string | Uint8Array | null>
  publish(token: string, state: string, plan: string | null): Promise<boolean>
  acquire(key: string, value: string, ttlSeconds: number): Promise<boolean>
  release(key: string, value: string): Promise<void>
}
type Storage = { read(key: string): Promise<string | null> }
type Scope = Pick<ImMaintenanceCursor, 'owner_user_id' | 'platform' | 'bot_id' | 'scope_type' | 'scope_id'>
type Stats = { status: 'running' | 'done'; done: number; total: number; needs_review: number; failed: number; total_batches: number; completed_batches: number; truncated_batches: number; plan_ready: boolean; ts: number }
type PublishProgress = (state: Stats, plans: readonly unknown[]) => Promise<boolean>

const publishPreview = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[4] == '' then
  redis.call('DEL', KEYS[3])
else
  redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[2])
end
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`

/** 状态和计划由同一租约发布，过期任务无法覆盖后续预览。 */
export function createImMemoryMaintenancePreviewState(commands: {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...options: string[]): Promise<unknown>
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
}): ValueStore {
  return {
    get: key => commands.get(key),
    async acquire(key, token, ttl) {
      return await commands.set(key, token, 'EX', String(ttl), 'NX') === 'OK'
    },
    async publish(token, state, plan) {
      return String(await commands.eval(publishPreview, 3, IM_MEMORY_MODEL_PREVIEW_LOCK_KEY, stateKey, planKey,
        token, String(TTL_SECONDS), state, plan ?? '')) === '1'
    },
    async release(key, token) {
      await commands.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end;return 0", 1, key, token)
    },
  }
}

export class ImMemoryMaintenancePreviewError extends Error {
  constructor(readonly statusCode: 409 | 503, message: string) { super(message) }
}

function decode(value: string | Uint8Array | null): string | null { return value === null ? null : typeof value === 'string' ? value : new TextDecoder().decode(value) }

async function readScope(scope: Scope, storage: Storage): Promise<Record<string, unknown>> {
  const files = scope.scope_type === 'group' ? ['profile.json', 'summary.json', 'daily.md', 'memory.md', 'members.json'] : ['profile.json', 'pattern.json', 'summary.json', 'daily.md', 'memory.md']
  const result: Record<string, unknown> = {}
  for (const filename of files) {
    const value = await storage.read(imMemoryMaintenanceScopeFileKey(scope, filename)), field = filename.replace(/\.(?:json|md)$/u, '')
    if (filename.endsWith('.md')) result[field] = value?.trim() ?? ''
    else if (!value?.trim()) result[field] = {}
    else {
      try { const parsed: unknown = JSON.parse(value); result[field] = record(parsed) || Array.isArray(parsed) ? parsed : {} }
      catch { result[field] = {} }
    }
  }
  return result
}

function render(message: ImMaintenanceMessage): string {
  const timestamp = message.created_at == null ? '未知时间' : message.created_at instanceof Date ? message.created_at.toISOString().replace(/Z$/u, '+00:00') : String(message.created_at)
  const name = message.platform_user_name || '未提供昵称', sender = message.platform_user_id || '未知ID'
  return `[${timestamp}] [${name}，platform_user_id=${sender}] ${message.content || '（无文字）'}`
}

export interface ImMemoryMaintenancePreviewWorkerPorts {
  messages(scope: Scope, fromId: number, toId: number): Promise<ImMaintenanceMessage[]>
  readonly storage: Storage
  readModelSettings(): ProviderConfig
  readPrompt(scopeType: Scope['scope_type']): Promise<string>
  complete(request: { system: string; prompt: string; maxTokens: number; config: ProviderConfig }): Promise<unknown>
  readonly now?: () => number
  readonly diagnose?: (error: unknown) => void
}

export function createImMemoryMaintenancePreviewWorker(ports: ImMemoryMaintenancePreviewWorkerPorts) {
  const now = ports.now ?? (() => Date.now() / 1000)
  return async function run(cursors: readonly ImMaintenanceCursor[], publish: PublishProgress): Promise<void> {
    let done = 0, needsReview = 0, failed = 0, totalBatches = 0, completedBatches = 0, truncatedBatches = 0
    const plans: unknown[] = []
    const total = cursors.length
    const modelSettings = ports.readModelSettings()
    const budget = resolveMaintenanceBudget(modelSettings)
    const state = (status: 'running' | 'done'): Stats => ({
      status, done, total, needs_review: needsReview, failed, total_batches: totalBatches,
      completed_batches: completedBatches, truncated_batches: truncatedBatches,
      plan_ready: status === 'running' ? plans.length > 0 : plans.length > 0 && failed === 0 && truncatedBatches === 0, ts: now(),
    })
    for (const cursor of cursors) {
      try {
        const [messages, current, stableSystem] = await Promise.all([
          // 游标追平时仍检查现有记忆，Python 的区间查询在此返回空消息。
          cursor.first_message_id > cursor.last_message_id ? [] : ports.messages(cursor, cursor.first_message_id, cursor.last_message_id),
          readScope(cursor, ports.storage), ports.readPrompt(cursor.scope_type),
        ])
        const result = await previewImMaintenanceScope({ scope: cursor, current, messages, render, stableSystem, budget,
          complete: request => ports.complete({ ...request, config: modelSettings }) })
        totalBatches += result.totalBatches
        completedBatches += result.completedBatches
        truncatedBatches += result.truncatedBatches
        if (result.plan) { plans.push(result.plan); needsReview++ }
        else if (result.failed) failed++
      } catch (error) {
        ports.diagnose?.(error)
        failed++
      }
      done++
      if (!await publish(state('running'), plans)) return
    }
    await publish(state('done'), plans)
  }
}

export function createImMemoryMaintenancePreviewStarter(ports: {
  readonly state: ValueStore | null
  listCursors(): Promise<ImMaintenanceCursor[]>
  run(cursors: readonly ImMaintenanceCursor[], publish: PublishProgress): Promise<void>
  readonly diagnose?: (error: unknown) => void
  readonly now?: () => number
}) {
  const now = ports.now ?? (() => Date.now() / 1000)
  return async function start(): Promise<{ ok: true; total: number } | { ok: false; message: string; status: unknown }> {
    const state = ports.state
    if (!state) throw new ImMemoryMaintenancePreviewError(503, 'Redis 维护计划服务不可用')
    const raw = await state.get(stateKey)
    if (raw) {
      const current: unknown = JSON.parse(decode(raw)!)
      if (record(current) && current.status === 'running') return { ok: false, message: '已有模型预览正在运行', status: current }
    }
    const token = randomUUID()
    if (!await state.acquire(IM_MEMORY_MODEL_PREVIEW_LOCK_KEY, token, TTL_SECONDS)) {
      const currentRaw = await state.get(stateKey)
      const current: unknown = currentRaw ? JSON.parse(decode(currentRaw)!) : null
      if (record(current) && current.status === 'running') return { ok: false, message: '已有模型预览正在运行', status: current }
      throw new ImMemoryMaintenancePreviewError(409, '已有模型预览正在启动')
    }
    let keepLock = false
    try {
      const cursors = await ports.listCursors()
      const initial = JSON.stringify({ status: 'running', done: 0, total: cursors.length, needs_review: 0, failed: 0, plan_ready: false, ts: now() })
      if (!await state.publish(token, initial, null)) throw new ImMemoryMaintenancePreviewError(409, '模型预览启动租约已过期')
      keepLock = true
      void ports.run(cursors, (progress, plans) => state.publish(token, JSON.stringify(progress), JSON.stringify(plans))).catch(async error => {
        ports.diagnose?.(error)
        const failed = JSON.stringify({ status: 'done', done: 0, total: cursors.length, needs_review: 0, failed: 1, plan_ready: false, ts: now() })
        await state.publish(token, failed, null).catch(() => {})
      }).finally(() => state.release(IM_MEMORY_MODEL_PREVIEW_LOCK_KEY, token).catch(() => {}))
      return { ok: true, total: cursors.length }
    } finally {
      if (!keepLock) await state.release(IM_MEMORY_MODEL_PREVIEW_LOCK_KEY, token).catch(() => {})
    }
  }
}
