import { ProviderError } from '../agent/providers/errors.js'
import { boundedScopeMemory, MAX_BATCH_CHARS, messageBatches, scopeRevision } from './maintenance-batches.js'
import { mergeImMaintenanceOutputs } from './im-maintenance-apply.js'
import type { ImMaintenanceCursor, ImMaintenanceMessage } from './im-maintenance-source.js'

export interface ImMaintenancePreviewBudget { outputTokens: number; batchChars: number; existingMemoryChars: number }
export interface ImMaintenancePreviewPlan extends ImMaintenanceCursor {
  output: Record<string, unknown>
  source_revision: string
  source_message_ids: string[]
  batch_count: number
}

/** Python worker 的单 scope 预览规则；Host 提供 prompt、模型调用与错误诊断。 */
export async function previewImMaintenanceScope(input: {
  scope: ImMaintenanceCursor
  current: unknown
  messages: readonly ImMaintenanceMessage[]
  render(message: ImMaintenanceMessage): string
  stableSystem: string
  budget: ImMaintenancePreviewBudget
  complete(request: { system: string; prompt: string; maxTokens: number }): Promise<unknown>
}): Promise<{
  plan?: ImMaintenancePreviewPlan
  failed: boolean
  totalBatches: number
  completedBatches: number
  truncatedBatches: number
}> {
  const batches = messageBatches(input.messages, input.render, message => message.id, { maxChars: input.budget.batchChars })
  const totalBatches = batches.length || 1
  const truncatedBatches = batches.filter(batch => batch.inputChars > MAX_BATCH_CHARS).length
  if (truncatedBatches) return { failed: true, totalBatches, completedBatches: 0, truncatedBatches }

  const sourceText = input.messages.map(input.render).join('\n')
  const sourceMessageIds = input.messages.map(message => String(message.id))
  const sourceRevision = scopeRevision(input.current, sourceMessageIds, sourceText)
  const existing = boundedScopeMemory(input.current, { maxChars: input.budget.existingMemoryChars })
  const pending: Array<{ entries: readonly ImMaintenanceMessage[]; depth: number; memory: string }> = batches.length
    ? batches.map(batch => ({ entries: batch.items, depth: 0, memory: existing }))
    : [{ entries: [], depth: 0, memory: existing }]
  const outputs: unknown[] = []
  let failed = false, completedBatches = 0, dynamicBatches = batches.length

  while (pending.length) {
    const item = pending.shift()!
    const payload = item.entries.map(input.render).join('\n')
    const prompt = `已有群组/用户记忆（受限视图）：\n${item.memory}\n\n本批新增消息：\n${payload || '（无新增消息；请仅检查现有记忆是否需要整理）'}`
    let output: unknown
    try {
      output = await input.complete({ system: input.stableSystem, prompt, maxTokens: input.budget.outputTokens })
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'context_overflow') {
        if (item.entries.length > 1 && item.depth < 4) {
          const mid = Math.floor(item.entries.length / 2)
          pending.unshift(
            { entries: item.entries.slice(0, mid), depth: item.depth + 1, memory: item.memory },
            { entries: item.entries.slice(mid), depth: item.depth + 1, memory: item.memory },
          )
          dynamicBatches++
          continue
        }
        if (item.entries.length <= 1 && item.memory) {
          pending.unshift({ ...item, memory: '' })
          continue
        }
      }
      failed = true
      break
    }
    if (!output || typeof output !== 'object' || Array.isArray(output)) { failed = true; break }
    if (existing && !item.memory) {
      const reduced: Record<string, unknown> = { ...(output as Record<string, unknown>) }
      delete reduced.summary
      delete reduced.profile_remove
      outputs.push(reduced)
    } else outputs.push(output)
    completedBatches++
  }
  if (failed) return { failed, totalBatches: dynamicBatches, completedBatches, truncatedBatches }
  return {
    failed: false, totalBatches: dynamicBatches, completedBatches, truncatedBatches,
    plan: {
      ...input.scope,
      first_message_id: input.messages.length ? input.messages[0]!.id : 0,
      last_message_id: input.messages.length ? input.messages.at(-1)!.id : 0,
      output: mergeImMaintenanceOutputs(outputs), source_revision: sourceRevision,
      source_message_ids: sourceMessageIds, batch_count: outputs.length,
    },
  }
}
