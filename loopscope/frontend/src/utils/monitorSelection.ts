/**
 * Resolve the visible run without letting background run-list refreshes steal
 * the operator's current selection.
 */
export function resolveMonitorSelection(options: {
  runIds: string[]
  selectedRunId: string
  focusRunId?: string
  focusChanged: boolean
}): string {
  const { runIds, selectedRunId, focusRunId, focusChanged } = options
  if (!runIds.length) return ''

  if (focusRunId && runIds.includes(focusRunId)
    && (focusChanged || !selectedRunId)) {
    return focusRunId
  }
  if (runIds.includes(selectedRunId)) return selectedRunId
  return runIds[0]
}
