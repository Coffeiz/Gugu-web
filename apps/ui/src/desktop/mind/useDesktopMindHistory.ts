import { desktopData } from '@desktop/bridge/bridge'
import { showAppNotice } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'
import { useLiveStore } from '@/stores/live'

const context = 'desktop-mind'
type HistoryEntry = { operation_id?: unknown; can_undo?: boolean; can_redo?: boolean }

export function useDesktopMindHistory() {
  const live = useLiveStore()
  const t = i18n.global.t
  return async (mode: 'undo' | 'redo') => {
    const history = await desktopData.undoPreview(context) as Record<typeof mode, HistoryEntry | null> | null
    const entry = history?.[mode]
    const available = mode === 'undo' ? entry?.can_undo : entry?.can_redo
    if (!available || typeof entry?.operation_id !== 'string') {
      showAppNotice(t(mode === 'undo' ? 'errors.undoUnavailable' : 'errors.redoUnavailable'))
      return
    }
    const requestId = crypto.randomUUID()
    const apply = mode === 'undo' ? desktopData.undoApply : desktopData.undoRedo
    await apply(context, entry.operation_id, requestId)
    live.bump('mind')
    showAppNotice(t(mode === 'undo' ? 'errors.undoCompleted' : 'errors.redoCompleted'))
  }
}
