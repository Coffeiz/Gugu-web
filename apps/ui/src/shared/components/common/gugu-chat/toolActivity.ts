import { formatShellActivityLabel, toolDisplayIdentity } from '@gugu/core/agent/sessions/tool-labels'
import { describeShellActivity } from '@gugu/core/agent/shell-activity'
import type { ChatMessage } from './chatTypes'

export function formatToolDuration(elapsed?: number) {
  if (elapsed == null || !Number.isFinite(elapsed) || elapsed < 0) return ''
  if (elapsed < 1000) return `${Math.round(elapsed)}ms`
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(elapsed / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds / 60) % 60
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return hours
    ? `${hours}h${String(minutes).padStart(2, '0')}m${seconds}s`
    : `${minutes}m${seconds}s`
}

export function toolGroupElapsedMs(tools: readonly ChatMessage[]) {
  let start = Infinity
  let end = -Infinity
  for (const tool of tools) {
    const created = Date.parse(tool._createdAt ?? '')
    const updated = Date.parse(tool._updatedAt ?? '')
    if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created)
      return tools.length === 1 ? tool.toolDurationMs : undefined
    start = Math.min(start, created)
    end = Math.max(end, updated)
  }
  return tools.length ? end - start : undefined
}

export function projectChatRows(messages: readonly ChatMessage[]) {
  const rows: { msg: ChatMessage; messageIndex: number; tools?: ChatMessage[]; elapsedMs?: number }[] = []
  const rowIndexByMessageIndex: number[] = []
  const runs = new Map<string, { user?: ChatMessage; last: ChatMessage; lastToolRow?: number }>()
  const shownSubagentOutputs = new Set<string>()
  const subagentNames = new Map<string, string>()
  const subagentStartedAt = new Map<string, number>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || msg.toolName !== 'agent_message') continue
    const receipt = subagentResult(msg.toolResult)
    if (receipt?.action !== 'spawn') continue
    const run = subagentResult(receipt.run)
    if (typeof run?.childId !== 'string' || typeof run.agentId !== 'string' || !run.agentId.trim()) continue
    subagentNames.set(run.childId, subagentDisplayName(run.agentId))
    const startedAt = Date.parse(typeof run.updatedAt === 'string' ? run.updatedAt : msg.toolStartedAt ?? msg._createdAt ?? '')
    if (Number.isFinite(startedAt)) subagentStartedAt.set(run.childId, startedAt)
  }
  let openGroupIndex: number | undefined
  for (const [messageIndex, msg] of messages.entries()) {
    const run = msg.runId ? runs.get(msg.runId) ?? { last: msg } : undefined
    if (msg.runId && run) {
      runs.set(msg.runId, run)
      run.last = msg
      if (msg.role === 'user') run.user = msg
    }
    if (msg.role === 'tool') {
      const output = readSubagentOutput(msg)
      if (msg.toolName === 'subagent_result') {
        rowIndexByMessageIndex.push(Math.max(0, rows.length - 1))
      } else {
        if (openGroupIndex === undefined || rows[openGroupIndex]!.msg.runId !== msg.runId) {
          openGroupIndex = rows.length
          rows.push({ msg, messageIndex, tools: [] })
        }
        rows[openGroupIndex]!.tools!.push(msg)
        rowIndexByMessageIndex.push(openGroupIndex)
        if (run) run.lastToolRow = openGroupIndex
      }
      if (output && !shownSubagentOutputs.has(output.key)) {
        shownSubagentOutputs.add(output.key)
        if (msg.toolName === 'subagent_result') rowIndexByMessageIndex[messageIndex] = rows.length
        const startedAt = subagentStartedAt.get(output.childId)
        const endedAt = Date.parse(msg._updatedAt ?? msg._createdAt ?? '')
        const subagentElapsedMs = startedAt !== undefined && Number.isFinite(endedAt) && endedAt >= startedAt
          ? endedAt - startedAt : undefined
        rows.push({
          messageIndex,
          msg: { id: -msg.id, role: 'member', subagentOutput: true, speakerLabel: subagentNames.get(output.childId),
            ...(subagentElapsedMs !== undefined ? { subagentElapsedMs } : {}), text: output.text, time: msg.time },
        })
        openGroupIndex = undefined
      }
    } else {
      rowIndexByMessageIndex.push(rows.length)
      rows.push({ msg, messageIndex })
      const emptyReply = msg.role === 'ai' && msg.streaming && !msg.text.trim()
        && !msg.files?.length && !msg.linkButtons?.buttons.length
      if (!emptyReply) openGroupIndex = undefined
    }
  }
  for (const { user, last, lastToolRow } of runs.values()) {
    if (lastToolRow === undefined || !user || user.runOutcome || last.role !== 'ai' || last.streaming) continue
    const start = Date.parse(user._createdAt ?? '')
    const end = Date.parse(last._completedAt ?? last._updatedAt ?? '')
    const elapsed = end - start
    if (Number.isFinite(elapsed) && elapsed >= 0) rows[lastToolRow]!.elapsedMs = elapsed
  }
  return { rows, rowIndexByMessageIndex, openGroupIndex, subagentNames }
}

export function shellActivityForMessage(msg: Pick<ChatMessage, 'toolName' | 'toolInput' | 'toolResult' | 'shellActivity'>) {
  return msg.toolName === 'shell' ? describeShellActivity(msg.toolInput, msg.toolResult) ?? msg.shellActivity : undefined
}

export function toolHasNoMatches(msg: ChatMessage) {
  return msg.toolStatus === 'error' && shellActivityForMessage(msg)?.noMatches === true
}

function subagentResult(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
}

function isSubagentTool(name?: string) {
  return name === 'agent_message' || name === 'agent_wait' || name === 'agent_inspect' || name === 'agent_cancel'
}

function subagentDisplayName(agentId: string) {
  return agentId === 'builtin:searcher' ? 'Searcher' : agentId
}

const visibleSubagentLimit = 20

export const subagentStatusKeys = {
  queued: 'toolQueued', running: 'toolRunning', waiting: 'toolWaiting', completed: 'toolDone',
  partial: 'subagentPartial', failed: 'toolFailed', cancelled: 'toolCancelled',
} as const

export function projectSubagentStatuses(messages: readonly ChatMessage[]) {
  const agents = new Map<string, {
    id: string; name?: string; parentRunId?: string; status: keyof typeof subagentStatusKeys
    round?: { number: number; messages: string[]; tools: string[] }
    finalMessage?: string
  }>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || (!isSubagentTool(msg.toolName) && msg.toolName !== 'subagent_result')) continue
    const result = subagentResult(msg.toolResult)
    if (!result) continue
    const runs = Array.isArray(result.runs) ? result.runs : [result.run ?? result]
    for (const value of runs) {
      const run = subagentResult(value)
      const id = run?.childId
      const status = result.started === true ? 'queued' : run?.status
      if (typeof id !== 'string' || typeof status !== 'string' || !Object.hasOwn(subagentStatusKeys, status)) continue
      const agentId = run?.agentId
      const prior = agents.get(id)
      const name = typeof agentId === 'string' ? subagentDisplayName(agentId) : prior?.name
      const latest = subagentResult(Array.isArray(result.rounds) ? result.rounds.at(-1) : result.round)
      const continuing = result.started === true || result.action === 'spawn' && prior?.status !== status
      let round = continuing ? undefined : prior?.round
      if (typeof latest?.number === 'number' && (!round || latest.number >= round.number)) {
        const messages = Array.isArray(latest.messages) ? latest.messages.filter((text): text is string => typeof text === 'string') : []
        const tools = Array.isArray(latest.toolCalls) ? latest.toolCalls.flatMap(value => {
          const tool = subagentResult(value)
          return typeof tool?.name === 'string' ? [tool.name] : []
        }) : []
        round = { number: latest.number, messages, tools }
      }
      const finalMessage = typeof result.finalMessage === 'string'
        ? result.finalMessage.slice(0, 1200)
        : continuing ? undefined : prior?.finalMessage
      // Map 按最近一次状态更新排序，而不是按首次派发排序。
      agents.delete(id)
      agents.set(id, { id, status: status as keyof typeof subagentStatusKeys, name, parentRunId: msg.runId ?? prior?.parentRunId, round, finalMessage })
    }
  }
  const recent = [...agents.values()].reverse().map(agent => ({
    ...agent,
    active: agent.status === 'queued' || agent.status === 'running' || agent.status === 'waiting',
    labelKey: 'chatUi.' + subagentStatusKeys[agent.status],
  }))
  return [...recent.filter(agent => agent.active),
    ...recent.filter(agent => !agent.active)].slice(0, visibleSubagentLimit)
}

export function needsSubagentDetails(msg: ChatMessage) {
  if (msg.role === 'tool' && isSubagentTool(msg.toolName) && msg.toolName !== 'agent_wait') return msg.toolResult === undefined
  if (msg.role !== 'tool' || (msg.toolName !== 'agent_wait' && msg.toolName !== 'subagent_result')) return false
  if (msg.toolResult === undefined) return true
  const result = subagentResult(msg.toolResult)
  return result?.alreadyDelivered === true && typeof result.finalMessage !== 'string'
}

function readSubagentOutput(msg: ChatMessage) {
  if (msg.toolName !== 'agent_wait' && msg.toolName !== 'subagent_result') return
  const result = subagentResult(msg.toolResult)
  if (typeof result?.childId !== 'string' || !/^[a-f0-9]{8}$/.test(result.childId)
      || typeof result.finalMessage !== 'string' || !result.finalMessage.trim()) return
  return { key: `${msg.runId ?? msg.id}:${result.childId}`, childId: result.childId, text: result.finalMessage }
}

export function toolActivityLabel(
  msg: Pick<ChatMessage, 'toolName' | 'toolInput' | 'toolResult' | 'shellActivity' | 'toolLabel' | 'toolLabelOverride'>,
  translate: (key: string, values?: Record<string, string>) => string,
  exists: (key: string) => boolean,
  subagentNames?: ReadonlyMap<string, string>,
) {
  const { name, input: toolInput } = toolDisplayIdentity(msg.toolName, msg.toolInput)
  if (isSubagentTool(name)) {
    const input = subagentResult(toolInput)
    const result = subagentResult(msg.toolResult)
    const run = subagentResult(result?.run)
    const agentId = run?.agentId ?? input?.agentId
    const childId = run?.childId ?? result?.childId ?? input?.childId
    const listedRuns = Array.isArray(result?.runs) ? result.runs : []
    const listedAgentId = subagentResult(listedRuns[0])?.agentId
    const singleListedAgent = typeof listedAgentId === 'string' &&
      listedRuns.every(item => subagentResult(item)?.agentId === listedAgentId) ? listedAgentId : undefined
    const resolvedAgentId = agentId ?? singleListedAgent
    const agentName = typeof resolvedAgentId === 'string' && resolvedAgentId.trim()
      ? subagentDisplayName(resolvedAgentId)
      : typeof childId === 'string' ? subagentNames?.get(childId) : undefined
    if (agentName) return translate(`toolNames.${name}_target`, { target: agentName })
  }
  if (name === 'read_file') return translate('chatUi.toolCall')
  const activity = shellActivityForMessage({ ...msg, toolName: name, toolInput })
  if (!msg.toolLabelOverride?.trim()) {
    const label = formatShellActivityLabel(activity, (key, values) => translate(`toolNames.${key}`, values), true)
    if (label) return label
  }
  const key = `toolNames.${name}`
  return msg.toolLabelOverride?.trim() || (name && exists(key) ? translate(key) : msg.toolLabel?.trim() || name || translate('chatUi.toolCall'))
}
