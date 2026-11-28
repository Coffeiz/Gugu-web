import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import type { createImMemorySummaryReader } from '@gugu/core/im-memory-summary'

import { deduplicateGroupEventMemory,groupDailyDatesPreserved,normalizeGroupEventMemory,parseGroupDailyEntries,renderGroupDailyEntries,shouldCompactGroupDaily,splitOldestGroupDailyBatch } from '@gugu/core/im-group-daily-compaction'

import type { ImMaintenanceCursor } from '@gugu/core/im-memory-maintenance-source'

import type { ProviderConfig } from '@gugu/core/providers'

import { imMemoryMaintenanceScopeFileKey } from './memory-apply.js'

export interface ImMemorySummaryOptions {
 requireAdmin:preHandlerHookHandler
 read:ReturnType<typeof createImMemorySummaryReader>
}

/** 维护预览和汇总使用同一只读用例，不触发模型或维护任务。 */
export function registerImMemorySummaryRoutes(app:FastifyInstance,options:ImMemorySummaryOptions):void {
 app.get('/api/v1/admin/agent/memory/im-scopes',{preHandler:options.requireAdmin},()=>options.read())
 app.post('/api/v1/admin/agent/memory/im-scopes/maintenance/preview',{preHandler:options.requireAdmin},()=>options.read())
}

type Scope = Pick<ImMaintenanceCursor, 'owner_user_id' | 'platform' | 'bot_id' | 'scope_type' | 'scope_id'>
type Storage = { write(key: string, text: string): Promise<void> }

export function createImMemoryGroupDailyCompactor(options: {
  readonly storage: Storage
  isTombstoned(scope: Scope): Promise<boolean>
  readPrompt(): Promise<string>
  readModelSettings(): ProviderConfig
  complete(request: { system: string; prompt: string; maxTokens: number; config: ProviderConfig }): Promise<unknown>
}) {
  return async function compact(scope: Scope, currentMemory: string, daily: string): Promise<void> {
    if (scope.scope_type !== 'group') return
    let pending = parseGroupDailyEntries(daily)
    if (!shouldCompactGroupDaily(pending.length)) return
    const prompt = await options.readPrompt()
    const settings = options.readModelSettings()
    while (pending.length) {
      const [remaining, batch] = splitOldestGroupDailyBatch(pending)
      if (!batch.length) return
      const completion = await options.complete({
        system: prompt,
        prompt: `已有长期记忆：\n${currentMemory}\n\n近期群聊记录：\n${renderGroupDailyEntries(batch)}`,
        maxTokens: 15_000,
        config: settings,
      })
      const raw = completion && typeof completion === 'object' && !Array.isArray(completion)
        ? (completion as Record<string, unknown>).memory : undefined
      const memory = deduplicateGroupEventMemory(normalizeGroupEventMemory(String(raw ?? '').trim(), '群组事件记录'))
      if (!memory || !groupDailyDatesPreserved(batch, memory)) return
      if (await options.isTombstoned(scope)) return
      await options.storage.write(imMemoryMaintenanceScopeFileKey(scope, 'memory.md'), `${memory}\n`)
      await options.storage.write(imMemoryMaintenanceScopeFileKey(scope, 'daily.md'), renderGroupDailyEntries(remaining))
      currentMemory = memory
      pending = remaining
    }
  }
}
