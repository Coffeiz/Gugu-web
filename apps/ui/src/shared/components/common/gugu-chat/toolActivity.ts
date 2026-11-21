import type { ChatMessage } from './chatTypes'

export function formatToolDuration(elapsed?: number) {
  if (elapsed == null || !Number.isFinite(elapsed) || elapsed < 0) return ''
  return elapsed < 1000 ? `${Math.round(elapsed)}ms` : `${(elapsed / 1000).toFixed(1)}s`
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
  let openGroupIndex: number | undefined
  for (const [messageIndex, msg] of messages.entries()) {
    const run = msg.runId ? runs.get(msg.runId) ?? { last: msg } : undefined
    if (msg.runId && run) {
      runs.set(msg.runId, run)
      run.last = msg
      if (msg.role === 'user') run.user = msg
    }
    if (msg.role === 'tool') {
      if (openGroupIndex === undefined || rows[openGroupIndex]!.msg.runId !== msg.runId) {
        openGroupIndex = rows.length
        rows.push({ msg, messageIndex, tools: [] })
      }
      rows[openGroupIndex]!.tools!.push(msg)
      rowIndexByMessageIndex.push(openGroupIndex)
      if (run) run.lastToolRow = openGroupIndex
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
  return { rows, rowIndexByMessageIndex, openGroupIndex }
}

export function toolActivityLabel(msg: ChatMessage, translate: (key: string) => string, exists: (key: string) => boolean) {
  const name = msg.toolName || ''
  const key = `toolNames.${name}`
  return msg.toolLabelOverride?.trim() || (name && exists(key) ? translate(key) : msg.toolLabel?.trim() || name || translate('chatUi.toolCall'))
}
