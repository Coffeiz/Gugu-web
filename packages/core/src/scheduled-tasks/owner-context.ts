import { agentCurrentTimeReminderBody } from '../agent/context/builder.js'
import { loadContextData } from '../agent/context/prepare.js'
import type { ContextSourceSelection, PrepareContextInput, RunIdentity } from '../agent/models.js'
import type { ContextDataPorts, ContextSourcePorts } from '../agent/ports.js'
import type { ScheduledTaskExecutionPlan } from './run-now-read.js'

const deliveryInstruction = '## 输出方式\n\n这轮对话不会流式展示给用户，所有工具都用完之后再一次性给出完整回复。工具调用之间不要输出过程性旁白。任务包含多个部分时，在最后一条回复中提供全部结果。'

export function createScheduledTaskContextLoader(options: {
  data: Omit<ContextDataPorts, 'loadNotes' | 'loadImMemory'>
  builder: ContextSourcePorts['builder']
  now(): number
  memoryEnabled: boolean
  identity: RunIdentity
  task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId'>
  model: { modelIdentity: string; contextWindow: number; accessScopeHash: string }
  prompt: string
}) {
  const { builder, now, prompt } = options
  const identity = { ...options.identity }
  const { modelIdentity, contextWindow, accessScopeHash } = options.model
  if (identity.ownerId !== options.task.ownerId || identity.sessionId !== `scheduled-task:${options.task.id}`)
    throw new Error('定时任务上下文身份不匹配')

  const selection: ContextSourceSelection = {
    modelIdentity, contextWindow, locale: 'zh-CN', groupChat: false, workspaceBinding: null,
    contextPolicy: { loadOwnerContext: true, memoryEnabled: options.memoryEnabled },
  }
  const dataPorts: ContextDataPorts = {
    ...options.data,
    // Python 定时任务不读取最近笔记；群资料已由定时执行用例独立核验并注入。
    async loadNotes() { return [] },
    async loadImMemory() { return {} },
  }

  return async (candidate: RunIdentity, signal: AbortSignal) => {
    if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId || candidate.runId !== identity.runId)
      throw new Error('定时任务上下文身份不匹配')

    const data = await loadContextData(identity, selection.contextPolicy, dataPorts, signal)
    const style = data.stylePreferences
    const locale = style && typeof style === 'object' && !Array.isArray(style) ? style.locale : undefined
    const selected = typeof locale === 'string' ? { ...selection, locale } : selection
    const snapshot = builder.buildSnapshot(data, selected, identity)
    snapshot.snapshotContext = [snapshot.snapshotContext, deliveryInstruction].filter(Boolean).join('\n\n')
    const request = builder.buildRequest(snapshot, selected, identity)
    const input: PrepareContextInput = {
      ownerId: identity.ownerId, sessionId: identity.sessionId, entryKind: 'scheduled_task',
      history: [], fixedPrefix: request.fixedPrefix, systemPrompt: request.systemPrompt, systemInMessages: request.systemInMessages,
      userTimezone: snapshot.userTimezone, snapshotText: snapshot.snapshotContext,
      currentUser: { message: { role: 'user', content: prompt }, rawText: prompt },
      extraReminder: agentCurrentTimeReminderBody(new Date(now()), snapshot.userTimezone),
    }
    return { modelIdentity, contextWindow, accessScopeHash, input }
  }
}
