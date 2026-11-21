const overlaySelector = '.bm-center:not(.bm-leave-active), [role="dialog"], .modal, .confirm-dialog'

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const editor = target.closest('input, textarea, select, [contenteditable]')
  return (target instanceof HTMLElement && target.isContentEditable)
    || (editor !== null && editor.getAttribute('contenteditable') !== 'false')
}

export function shortcutKey(event: KeyboardEvent): string | undefined {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey
    || !(event.ctrlKey || event.metaKey) || isEditableTarget(event.target)) return
  return event.key.toLowerCase()
}

export function hasShortcutOverlay(target: EventTarget | null): boolean {
  return (target instanceof Element && !!target.closest(overlaySelector))
    || !!document.querySelector('.bm-overlay:not(.bm-ov-leave-from):not(.bm-ov-leave-active), .confirm-dialog')
}

export function hasTextSelection(): boolean {
  const selection = window.getSelection()
  return !!selection && !selection.isCollapsed
}
