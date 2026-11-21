import { computed, ref } from 'vue'

const SIDEBAR_WIDTH_KEY = 'gugu.desktop.sidebar-width'
const SIDEBAR_COMPACT_WIDTH = 56
const SIDEBAR_CONTROL_MIN_WIDTH = 0
const SIDEBAR_COMPACT_THRESHOLD = 120
const SIDEBAR_FULL_MIN_WIDTH = 150
const SIDEBAR_MAX_WIDTH = 200

export function useDesktopSidebar() {
  const width = ref(150)
  const compact = computed(() => width.value < SIDEBAR_COMPACT_THRESHOLD)
  let resizeStart: { pointerX: number; width: number } | null = null
  let controlWidth = width.value

  function applyControlWidth() {
    width.value = controlWidth < SIDEBAR_COMPACT_THRESHOLD
      ? SIDEBAR_COMPACT_WIDTH
      : Math.max(SIDEBAR_FULL_MIN_WIDTH, controlWidth)
  }

  function restore() {
    const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    if (!Number.isFinite(savedWidth) || savedWidth <= 0 || savedWidth > SIDEBAR_MAX_WIDTH) return
    controlWidth = savedWidth
    applyControlWidth()
    controlWidth = width.value
  }

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return
    controlWidth = width.value
    resizeStart = { pointerX: event.clientX, width: controlWidth }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function resize(event: PointerEvent) {
    if (!resizeStart) return
    controlWidth = Math.max(SIDEBAR_CONTROL_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, resizeStart.width + event.clientX - resizeStart.pointerX))
    applyControlWidth()
  }

  function finishResize() {
    if (!resizeStart) return
    applyControlWidth()
    controlWidth = width.value
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width.value))
    resizeStart = null
  }

  function handleResizeKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft') controlWidth = Math.max(SIDEBAR_CONTROL_MIN_WIDTH, controlWidth - 16)
    else if (event.key === 'ArrowRight') controlWidth = Math.min(SIDEBAR_MAX_WIDTH, compact.value
      ? SIDEBAR_COMPACT_THRESHOLD
      : controlWidth + 16)
    else if (event.key === 'Home') controlWidth = SIDEBAR_CONTROL_MIN_WIDTH
    else if (event.key === 'End') controlWidth = SIDEBAR_MAX_WIDTH
    else return
    applyControlWidth()
    event.preventDefault()
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width.value))
  }

  return { width, compact, restore, startResize, resize, finishResize, handleResizeKeydown, minWidth: SIDEBAR_COMPACT_WIDTH, maxWidth: SIDEBAR_MAX_WIDTH }
}
