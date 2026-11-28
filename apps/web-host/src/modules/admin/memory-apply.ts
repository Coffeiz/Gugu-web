import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { openLocalFile,UnsafeLocalPathError,writeLocalFile } from '@gugu/fs/node'

import { applyImMaintenanceOutput } from '@gugu/core/im-memory-maintenance-apply'
import { imMemoryScopeFileKey, type ImMemoryScopeFile } from '@gugu/core/im/memory-source'

import { scopeRevision } from '@gugu/core/im-memory-maintenance-batches'

import { GROUP_DAILY_HARD_CAP,parseGroupDailyEntries } from '@gugu/core/im-group-daily-compaction'

import type { ImMaintenanceCursor,ImMaintenanceMessage } from '@gugu/core/im-memory-maintenance-source'

export function createLocalImMemoryMaintenanceStorage(root: string): ImMemoryMaintenanceApplyPorts['storage'] {
  return {
    async read(key) {
      let opened
      try { opened = await openLocalFile(root, key) }
      catch (error) { if (error instanceof UnsafeLocalPathError) throw error; throw new Error('IM 记忆文件读取失败') }
      if (!opened) return null
      try {
        if (opened.size > 2 * 1024 * 1024) throw new Error('IM 记忆文件超出限制')
        return new TextDecoder('utf-8', { fatal: true }).decode(await opened.handle.readFile())
      } finally { await opened.handle.close() }
    },
    async write(key, text) {
      try { await writeLocalFile(root, key, text) }
      catch (error) { if (error instanceof UnsafeLocalPathError) throw error; throw new Error('IM 记忆文件写入失败') }
    },
  }
}

export function registerImMemoryMaintenanceApplyRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  apply(confirm: unknown): ReturnType<ReturnType<typeof createImMemoryMaintenanceApplier>>
}): void {
  app.post<{ Body: { confirm?: unknown } }>('/api/v1/admin/agent/memory/im-scopes/maintenance/apply', { preHandler: options.requireAdmin }, async (request, reply) => {
    try { return await options.apply(request.body?.confirm) }
    catch (error) {
      if (error instanceof ImMemoryMaintenanceApplyError) return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}

export const IM_MEMORY_MODEL_PREVIEW_KEY = 'im_memory:maintenance:model_preview'
export const IM_MEMORY_MODEL_PREVIEW_PLAN_KEY = 'im_memory:maintenance:model_preview:plan'

export class ImMemoryMaintenanceApplyError extends Error {
  constructor(readonly statusCode: 400 | 409, message: string) { super(message) }
}

export interface ImMemoryMaintenanceApplyPorts {
  state: {
    get(key: string): Promise<string | Uint8Array | null>
    delete(key: string): Promise<void>
  }
  messages(scope: Pick<ImMaintenanceCursor, 'owner_user_id' | 'platform' | 'bot_id' | 'scope_type' | 'scope_id'>, fromId: number, toId: number): Promise<ImMaintenanceMessage[]>
  isTombstoned(scope: Pick<ImMaintenanceCursor, 'owner_user_id' | 'platform' | 'bot_id' | 'scope_type' | 'scope_id'>): Promise<boolean>
  storage: {
    read(key: string): Promise<string | null>
    write(key: string, text: string): Promise<void>
  }
  /** RAG 投影先撤回旧文档；scope 文件变更后推进可信 revision 并排入重建。 */
  memoryIndex: {
    invalidate(ownerId: string): Promise<void>
    changed(scope: Pick<ImMaintenanceCursor, 'owner_user_id' | 'platform' | 'bot_id' | 'scope_type' | 'scope_id'>): Promise<void>
  }
  compactGroupDaily?(scope: Pick<ImMaintenanceCursor, 'owner_user_id' | 'platform' | 'bot_id' | 'scope_type' | 'scope_id'>, currentMemory: string, daily: string): Promise<void>
  onGroupDailyCompactionError?(): void
  now?: () => number
}

type RecordValue = Record<string, unknown>
type ScopePlan = ImMaintenanceCursor & {
  output?: unknown
  source_revision?: unknown
  source_message_ids?: unknown
  first_message_id?: unknown
  last_message_id?: unknown
}
const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const decode = (value: string | Uint8Array | null): string | null => value === null ? null : typeof value === 'string' ? value : new TextDecoder().decode(value)
const requiredText = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ImMemoryMaintenanceApplyError(400, '模型预览计划无效')
  return value
}

function safeComponent(value: unknown): string {
  const text = requiredText(value).trim()
  if (text === '.' || text === '..' || /[/\\\0]/u.test(text)) throw new ImMemoryMaintenanceApplyError(400, '模型预览计划无效')
  return text
}

export function imMemoryMaintenanceScopeFileKey(plan: Pick<ImMaintenanceCursor, 'owner_user_id' | 'platform' | 'bot_id' | 'scope_type' | 'scope_id'>, filename: string): string {
  const type = plan.scope_type
  if (type !== 'group' && type !== 'platform-user') throw new ImMemoryMaintenanceApplyError(400, '模型预览计划无效')
  try { return imMemoryScopeFileKey(plan as ImMemoryScopeFile, filename) }
  catch { throw new ImMemoryMaintenanceApplyError(400, '模型预览计划无效') }
}

async function readScope(plan: ScopePlan, storage: ImMemoryMaintenanceApplyPorts['storage']): Promise<RecordValue> {
  const files = plan.scope_type === 'group'
    ? ['profile.json', 'summary.json', 'daily.md', 'memory.md', 'members.json']
    : ['profile.json', 'pattern.json', 'summary.json', 'daily.md', 'memory.md']
  const scope: RecordValue = {}
  for (const filename of files) {
    const key = imMemoryMaintenanceScopeFileKey(plan, filename)
    const raw = await storage.read(key)
    const field = filename.replace(/\.(?:json|md)$/u, '')
    if (filename.endsWith('.md')) scope[field] = raw?.trim() ?? ''
    else if (!raw?.trim()) scope[field] = {}
    else {
      try {
        const parsed: unknown = JSON.parse(raw)
        scope[field] = parsed && typeof parsed === 'object' ? parsed : {}
      } catch { scope[field] = {} }
    }
  }
  return scope
}

function renderMessage(message: ImMaintenanceMessage): string {
  const timestamp = message.created_at == null ? '未知时间'
    : message.created_at instanceof Date ? message.created_at.toISOString().replace(/Z$/u, '+00:00')
      : String(message.created_at)
  const name = message.platform_user_name || '未提供昵称'
  const sender = message.platform_user_id || '未知ID'
  return `[${timestamp}] [${name}，platform_user_id=${sender}] ${message.content || '（无文字）'}`
}

function sourceDate(messages: ImMaintenanceMessage[], now: number): string {
  const latest = messages.at(-1)?.created_at
  const date = latest instanceof Date ? latest : latest ? new Date(latest) : new Date(now * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date(now * 1000).toISOString().slice(0, 10)
}

function jsonFile(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

function filesToWrite(scopeType: string, result: ReturnType<typeof applyImMaintenanceOutput>): Array<[string, string]> {
  const files: Array<[string, string]> = []
  if (result.profile !== undefined) files.push(['profile.json', jsonFile(result.profile)])
  if (scopeType === 'group') {
    if (result.members !== undefined) files.push(['members.json', jsonFile(result.members)])
    if (result.daily !== undefined) files.push(['daily.md', result.daily])
    if (result.summary !== undefined) files.push(['summary.json', jsonFile(result.summary)])
  } else {
    if (result.pattern !== undefined) files.push(['pattern.json', jsonFile(result.pattern)])
    if (result.summary !== undefined) files.push(['summary.json', jsonFile(result.summary)])
    if (result.daily !== undefined) files.push(['daily.md', result.daily])
  }
  return files
}

/**
 * 消费与旧版兼容的 Redis 预览计划，写入文件前校验所有来源版本；
 * 存储和数据库访问由 Host 适配器提供。
 */
export function createImMemoryMaintenanceApplier(ports: ImMemoryMaintenanceApplyPorts) {
  const now = ports.now ?? (() => Date.now() / 1000)
  return async function apply(confirm: unknown): Promise<{ ok: true; applied: number; queued: number }> {
    if (confirm !== true) throw new ImMemoryMaintenanceApplyError(400, '执行 IM 记忆维护需要 confirm=true')
    const [rawState, rawPlan] = await Promise.all([
      ports.state.get(IM_MEMORY_MODEL_PREVIEW_KEY), ports.state.get(IM_MEMORY_MODEL_PREVIEW_PLAN_KEY),
    ])
    if (!rawState || !rawPlan) throw new ImMemoryMaintenanceApplyError(400, '没有可执行的模型预览，请先生成预览')
    const state = JSON.parse(decode(rawState)!) as RecordValue
    if (state.status !== 'done') throw new ImMemoryMaintenanceApplyError(400, '模型预览尚未完成')
    if (state.plan_ready !== true) throw new ImMemoryMaintenanceApplyError(400, '模型预览包含失败或超长批次，请处理后重新生成预览')
    const parsedPlan: unknown = JSON.parse(decode(rawPlan)!)
    if (!Array.isArray(parsedPlan)) throw new ImMemoryMaintenanceApplyError(400, '模型预览计划无效')
    const plans = parsedPlan.map(raw => {
      if (!isRecord(raw)) throw new ImMemoryMaintenanceApplyError(400, '模型预览计划无效')
      const scopeType = raw.scope_type
      if (scopeType !== 'group' && scopeType !== 'platform-user') throw new ImMemoryMaintenanceApplyError(400, '模型预览计划无效')
      const first = Number(raw.first_message_id ?? 0), last = Number(raw.last_message_id ?? 0)
      if (!Number.isSafeInteger(first) || first < 0 || !Number.isSafeInteger(last) || last < first)
        throw new ImMemoryMaintenanceApplyError(400, '模型预览计划无效')
      return { ...raw, owner_user_id: safeComponent(raw.owner_user_id), platform: safeComponent(raw.platform), bot_id: safeComponent(raw.bot_id), scope_type: scopeType, scope_id: safeComponent(raw.scope_id), first_message_id: first, last_message_id: last } as ScopePlan
    })

    const validated: Array<{ plan: ScopePlan; current: RecordValue; messages: ImMaintenanceMessage[] }> = []
    for (const plan of plans) {
      const [current, messages] = await Promise.all([
        readScope(plan, ports.storage),
        ports.messages(plan, Number(plan.first_message_id), Number(plan.last_message_id)),
      ])
      const ids = messages.map(message => String(message.id))
      const sourceText = messages.map(renderMessage).join('\n')
      if (scopeRevision(current, ids, sourceText) !== plan.source_revision)
        throw new ImMemoryMaintenanceApplyError(409, '记忆预览已过期，源数据发生变化，请重新生成预览')
      if (Array.isArray(plan.source_message_ids) && JSON.stringify(ids) !== JSON.stringify(plan.source_message_ids.map(String)))
        throw new ImMemoryMaintenanceApplyError(409, '记忆预览已过期，源数据发生变化，请重新生成预览')
      validated.push({ plan, current, messages })
    }

    let applied = 0
    const invalidatedOwners = new Set<string>()
    for (const { plan, current, messages } of validated) {
      const appliedAt = now()
      const result = applyImMaintenanceOutput({
        scopeType: plan.scope_type, current, output: plan.output ?? {},
        now: appliedAt, date: sourceDate(messages, appliedAt),
      })
      let dailyWritten = false
      let changed = false
      let failed = false
      let failure: unknown
      try {
        for (const [filename, content] of filesToWrite(plan.scope_type, result)) {
          if (await ports.isTombstoned(plan)) break
          if (!invalidatedOwners.has(plan.owner_user_id)) {
            await ports.memoryIndex.invalidate(plan.owner_user_id)
            invalidatedOwners.add(plan.owner_user_id)
          }
          // write 实现可能在抛错前已完成原子替换；先标记，finally 路径仍刷新实际文件状态。
          changed = true
          await ports.storage.write(imMemoryMaintenanceScopeFileKey(plan, filename), content)
          if (filename === 'daily.md') dailyWritten = true
        }
      } catch (error) {
        failed = true
        failure = error
      }
      if (plan.scope_type === 'group' && dailyWritten && result.daily !== undefined && ports.compactGroupDaily) {
        try { await ports.compactGroupDaily(plan, typeof current.memory === 'string' ? current.memory : '', result.daily) }
        catch {
          if (parseGroupDailyEntries(result.daily).length >= GROUP_DAILY_HARD_CAP) ports.onGroupDailyCompactionError?.()
        }
      }
      // 若文件写入部分失败，仍为已写入的实际状态推进 scope revision 并排入重建；
      // 失败时旧索引已在写入前撤回，不能继续返回过期内容。
      if (changed) {
        try { await ports.memoryIndex.changed(plan) }
        catch (error) { if (!failed) { failed = true; failure = error } }
      }
      if (failed) throw failure
      applied++
    }
    await ports.state.delete(IM_MEMORY_MODEL_PREVIEW_PLAN_KEY)
    return { ok: true, applied, queued: applied }
  }
}
