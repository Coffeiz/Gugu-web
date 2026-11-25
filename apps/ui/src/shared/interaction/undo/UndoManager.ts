import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'
import { undoApi } from '@/services/api'

export { isEditableTarget } from '@/interaction/keyboardShortcuts'
import { hasShortcutOverlay, shortcutKey } from '@/interaction/keyboardShortcuts'

export function undoShortcutMode(event: KeyboardEvent, allowOverlay = false): 'undo' | 'redo' | undefined {
  const key = shortcutKey(event)
  if (!key || (!allowOverlay && hasShortcutOverlay(event.target))) return
  if (key === 'y' && !event.shiftKey) return 'redo'
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
}

export class UndoManager {
  private running = false
  private applying = false
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const mode = undoShortcutMode(event)
    if (!mode) return
    event.preventDefault()
    void this.apply(mode)
  }

  start(): void {
    if (this.running || typeof window === 'undefined') return
    window.addEventListener('keydown', this.onKeyDown)
    this.running = true
  }

  stop(): void {
    if (!this.running || typeof window === 'undefined') return
    window.removeEventListener('keydown', this.onKeyDown)
    this.running = false
  }

  private async apply(mode: 'undo' | 'redo'): Promise<void> {
    if (this.applying) return
    this.applying = true
    try {
      const preview = await undoApi.preview()
      const operation = mode === 'undo' ? preview.undo : preview.redo
      if (!operation) {
        showAppNotice(i18n.global.t(mode === 'undo' ? 'errors.undoUnavailable' : 'errors.redoUnavailable'))
        return
      }
      if (mode === 'undo') await undoApi.undo(operation.operation_id)
      else await undoApi.redo(operation.operation_id)
      showAppNotice(i18n.global.t(mode === 'undo' ? 'errors.undoCompleted' : 'errors.redoCompleted'))
    } catch (error) {
      showAppError(errorMessage(error, i18n.global.t('errors.undoFailed')))
    } finally {
      this.applying = false
    }
  }
}

export const undoManager = new UndoManager()
