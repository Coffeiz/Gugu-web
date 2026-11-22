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
  for (const msg of messages) {
    if (msg.role !== 'tool' || msg.toolName !== 'agent_message') continue
    const receipt = subagentResult(msg.toolResult)
    if (receipt?.action !== 'start') continue
    const run = subagentResult(receipt.run)
    if (typeof run?.childId !== 'string' || typeof run.agentId !== 'string' || !run.agentId.trim()) continue
    subagentNames.set(run.childId, subagentDisplayName(run.agentId))
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
        rows.push({
          messageIndex,
          msg: { id: -msg.id, role: 'member', subagentOutput: true, speakerLabel: subagentNames.get(output.childId), text: output.text, time: msg.time },
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
  translate: (key: string, values?: { target: string }) => string,
  exists: (key: string) => boolean,
  subagentNames?: ReadonlyMap<string, string>,
) {
  const name = msg.toolName || ''
  if (isSubagentTool(name)) {
    const input = subagentResult(msg.toolInput)
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
  const activity = shellActivityForMessage(msg)
  if (!msg.toolLabelOverride?.trim() && activity) {
    const key = `toolNames.shell_${activity.action}`
    return activity.target ? translate(`${key}_target`, { target: activity.target }) : translate(key)
  }
  const key = `toolNames.${name}`
  return msg.toolLabelOverride?.trim() || (name && exists(key) ? translate(key) : msg.toolLabel?.trim() || name || translate('chatUi.toolCall'))
}
