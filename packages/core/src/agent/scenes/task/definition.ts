import { agentCurrentTimeReminderBody } from '../../context/builder.js'
import { compileContextFragments } from '../../context/fragment-plan.js'
import type { ContextData, ContextSourceSelection, PrepareContextInput, RunIdentity } from '../../models.js'
import type { ContextSourcePorts } from '../../ports.js'

const deliveryInstruction = '## 输出方式\n\n这轮对话不会流式展示给用户，所有工具都用完之后再一次性给出完整回复。工具调用之间不要输出过程性旁白。任务包含多个部分时，在最后一条回复中提供全部结果。'

export function assembleScheduledTaskContext(options: {
  builder: ContextSourcePorts['builder']
  data: ContextData
  selection: ContextSourceSelection
  identity: RunIdentity
  prompt: string
  now?: () => number
}): PrepareContextInput {
  const { builder, data, selection, identity, prompt } = options
  const snapshot = builder.buildSnapshot(data, selection, identity)
  // 投递说明沿用原请求中的固定位置，避免改变既有任务提示词。
  const snapshotText = [snapshot.snapshotContext, deliveryInstruction].filter(Boolean).join('\n\n')
  const request = builder.buildRequest({ ...snapshot, snapshotContext: snapshotText }, selection, identity)
  const { system, snapshot: stable, turn } = compileContextFragments([
    { id: 'task.instructions', version: 1, region: 'system', kind: 'instruction', value: request.systemPrompt },
    { id: 'task.overview', version: 1, region: 'snapshot', kind: 'data', value: snapshotText },
    { id: 'task.trigger', version: 1, region: 'turn', kind: 'data', value: prompt },
  ])
  const trigger = turn[0]!.value
  return {
    ownerId: identity.ownerId, sessionId: identity.sessionId, entryKind: 'scheduled_task',
    history: [], fixedPrefix: request.fixedPrefix, systemPrompt: system[0]!.value, systemInMessages: request.systemInMessages,
    userTimezone: snapshot.userTimezone, snapshotText: stable[0]!.value,
    currentUser: { message: { role: 'user', content: trigger }, rawText: trigger },
    ...(options.now ? { extraReminder: agentCurrentTimeReminderBody(new Date(options.now()), snapshot.userTimezone) } : {}),
  }
}
