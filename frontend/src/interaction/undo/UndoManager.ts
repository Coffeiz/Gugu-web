import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'
import { undoApi } from '@/services/api'

export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  return element.isContentEditable || element.getAttribute('contenteditable') === 'true'
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
}

function isProtectedOverlay(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  return !!element?.closest('[role="dialog"], .modal, .confirm-dialog')
}

export class UndoManager {
  private running = false
  private applying = false
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat || isEditableTarget(event.target)
      || isProtectedOverlay(event.target)) return
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
    event.preventDefault()
    void this.apply(event.shiftKey ? 'redo' : 'undo')
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
