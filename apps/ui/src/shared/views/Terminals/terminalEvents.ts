import type { TerminalEventItem } from '@/services/api'

export type TerminalEventView = TerminalEventItem & {
  localId?: string
  state?: 'running' | 'failed' | 'cancelled'
}

/** 合并实时输出、状态和最终事件，保证乐观占位记录不会重复显示。 */
export function replaceOrAppendTerminalEvent(events: TerminalEventView[], event: TerminalEventItem): void {
  if (event.type === 'output') {
    const pendingIndex = events.findIndex(item => item.state === 'running'
      && (item.runId === event.runId || item.command === event.command))
    if (pendingIndex >= 0) {
      const current = events[pendingIndex]
      events[pendingIndex] = { ...current, stdout: current.stdout + event.stdout, stderr: current.stderr + event.stderr }
    }
    return
  }
  if (event.type === 'status' && event.stdout === 'running') {
    const pendingIndex = events.findIndex(item => item.state === 'running' && item.command === event.command)
    if (pendingIndex >= 0) return
    events.push({ ...event, type: 'command', stdout: '', state: 'running' })
    return
  }
  if (event.stderr === '命令已取消') {
    const cancelledIndex = events.findIndex(item => item.state === 'running' && item.runId === event.runId)
    if (cancelledIndex >= 0) events[cancelledIndex] = { ...event, state: 'cancelled' }
    else if (!events.some(item => item.runId === event.runId || item.sequence === event.sequence)) events.push({ ...event, state: 'cancelled' })
    return
  }
  const pendingIndex = events.findIndex(item => item.state === 'running' && item.command === event.command)
  if (pendingIndex >= 0) events[pendingIndex] = event
  else if (!events.some(item => item.sequence === event.sequence)) events.push(event)
}
