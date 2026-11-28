import type { DisplayItem } from '../models.js'

export const finalToolStatuses = new Set(['success', 'error', 'skipped', 'cancelled', 'stopped', 'deferred', 'unknown'])

/** 对展示事件做有身份的upsert：更新状态不能改变原位置、首次时间或anchor。 */
function updateToolTiming(previous: DisplayItem | undefined, status: string | undefined, now: string): Partial<DisplayItem> {
  if (status === 'running') return {
    toolStartedAt: previous?.toolStatus === 'running' ? previous.toolStartedAt ?? previous.updatedAt : now,
  }
  if (previous?.toolStatus !== 'running' || status === undefined) return {}
  const elapsed = Date.parse(now) - Date.parse(previous.toolStartedAt ?? previous.updatedAt)
  return {
    toolStartedAt: null,
    ...(Number.isFinite(elapsed) ? { toolDurationMs: (previous.toolDurationMs ?? 0) + Math.max(0, elapsed) } : {}),
  }
}

export function updateDisplayItem(items: readonly DisplayItem[], incoming: Pick<DisplayItem, 'kind' | 'runId' | 'roundId'> & Partial<DisplayItem>, scope: {
  readonly anchorMessageId: string | null
  readonly now: string
}): readonly DisplayItem[] {
  const index = items.findIndex((item) => incoming.eventId ? item.eventId === incoming.eventId : incoming.kind === 'tool' && item.kind === 'tool' && item.runId === incoming.runId && item.roundId === incoming.roundId && item.toolCallId === incoming.toolCallId)
  if (index >= 0) {
    const old = items[index]!
    if (finalToolStatuses.has(old.toolStatus ?? '') && ['queued', 'running', 'waiting'].includes(incoming.toolStatus ?? ''))
      return items
    const next = [...items]
    next[index] = {
      ...old, ...incoming, ...(old.kind === 'tool' ? updateToolTiming(old, incoming.toolStatus, scope.now) : {}),
      eventId: old.eventId, sequence: old.sequence, anchorMessageId: old.anchorMessageId,
      timelineOrder: old.timelineOrder, createdAt: old.createdAt, updatedAt: scope.now,
    }
    return next
  }
  const sequence = items.length + 1
  const timelineOrder = scope.anchorMessageId === null ? null : (BigInt(scope.anchorMessageId) * 1000000n + BigInt(sequence)).toString()
  return [...items, {
    ...incoming,
    ...(incoming.kind === 'tool' ? updateToolTiming(undefined, incoming.toolStatus, scope.now) : {}),
    eventId: incoming.eventId ?? `${incoming.runId}:display:${sequence}`,
    sequence, anchorMessageId: scope.anchorMessageId, timelineOrder,
    createdAt: scope.now, updatedAt: scope.now,
  }]
}

/** 封存只关闭仍打开的气泡，不补造身份、时间和顺序，也不改调用方原数组。 */
export function sealDisplayTimeline(items: readonly DisplayItem[], now: string,
  incomplete: boolean | ((item: DisplayItem) => boolean) = false): readonly DisplayItem[] {
  const isOpen = (item: DisplayItem) => item.kind === 'tool' && ['queued', 'running', 'waiting'].includes(item.toolStatus ?? '')
  const unresolvedIndex = incomplete === true ? items.findLastIndex(item => isOpen(item) && item.toolStatus !== 'queued') : -1
  return items.map((item, index) => {
    if (!isOpen(item)) return item
    const unknown = typeof incomplete === 'function' ? incomplete(item) : index === unresolvedIndex
    const toolStatus = unknown ? 'unknown' : 'stopped'
    return { ...item, ...updateToolTiming(item, toolStatus, now), toolStatus, updatedAt: now }
  })
}
