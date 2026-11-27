import { selectScheduledAgentScene } from '../policy.js'
import { loadContextData } from '../../context/prepare.js'
import { assembleScheduledTaskContext } from './context.js'
import type { ContextSourceSelection, RunIdentity } from '../../models.js'
import type { ContextDataPorts, ContextSourcePorts } from '../../ports.js'
import type { ScheduledTaskExecutionPlan } from '../../../tasks/run-now-read.js'


export function createScheduledTaskContextLoader(options: {
  data: Pick<ContextDataPorts, 'loadTimezone' | 'loadStylePreferences' | 'loadMemory' | 'loadImChannels'>
    & Partial<Pick<ContextDataPorts, 'loadProjects' | 'loadEvents' | 'loadFilesOverview' | 'loadKnowledge'>>
  loadGroupStyle?: ContextDataPorts['loadStylePreferences']
  builder: ContextSourcePorts['builder']
  now(): number
  currentTimeReminder?: boolean
  memoryEnabled: boolean
  identity: RunIdentity
  task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'payload' | 'groupScope'> & Partial<Pick<ScheduledTaskExecutionPlan, 'channels'>>
  model: { modelIdentity: string; contextWindow: number; accessScopeHash: string }
  prompt: string
}) {
  const { builder, now, prompt, task } = options
  const identity = { ...options.identity }
  const { modelIdentity, contextWindow, accessScopeHash } = options.model
  if (identity.ownerId !== options.task.ownerId || identity.sessionId !== `scheduled-task:${options.task.id}`)
    throw new Error('定时任务上下文身份不匹配')

  const selection: ContextSourceSelection = {
    modelIdentity, contextWindow, locale: 'zh-CN', groupChat: Boolean(options.task.groupScope), workspaceBinding: null,
    scene: selectScheduledAgentScene(task.channels, Boolean(task.groupScope)),
    contextPolicy: { loadOwnerContext: !options.task.groupScope, memoryEnabled: options.memoryEnabled && !options.task.groupScope },
  }
  const dataPorts: ContextDataPorts = {
    async loadProjects() { return [] },
    async loadEvents() { return [] },
    async loadFilesOverview() { return {} },
    async loadKnowledge() { return [] },
    ...options.data,
    // Python 定时任务不读取最近笔记；群资料已由定时执行用例独立核验并注入。
    async loadNotes() { return [] },
    async loadImMemory() { return {} },
  }

  return async (candidate: RunIdentity, signal: AbortSignal) => {
    if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId || candidate.runId !== identity.runId)
      throw new Error('定时任务上下文身份不匹配')

    const data = await loadContextData(identity, selection.contextPolicy, dataPorts, signal, options.task.payload)
    if (task.groupScope) {
      data.imChannels = { [task.groupScope.platform]: true }
      if (options.loadGroupStyle) data.stylePreferences = await options.loadGroupStyle(identity, signal)
    }
    const style = data.stylePreferences
    const locale = style && typeof style === 'object' && !Array.isArray(style) ? style.locale : undefined
    const selected = typeof locale === 'string' ? { ...selection, locale } : selection
    const input = assembleScheduledTaskContext({ builder, data, selection: selected, identity, prompt,
      ...(options.currentTimeReminder === false ? {} : { now }) })
    return { modelIdentity, contextWindow, accessScopeHash, input }
  }
}
