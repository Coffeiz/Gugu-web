import { computed, onScopeDispose, ref } from 'vue'

/** 外部文件拖入状态：按容器边界判断离开，不依赖可能丢失配对的 enter/leave 次数。 */
export function useFileDropHover() {
  const depth = ref(0)
  let root: HTMLElement | undefined
  const reset = () => { depth.value = 0; root = undefined }
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
  function over(event: DragEvent) {
    if (!hasFiles(event)) return
    event.preventDefault()
    root = event.currentTarget instanceof HTMLElement ? event.currentTarget : root
    depth.value = 1
  }
  function leave(event: DragEvent) {
    if (!root) return reset()
    if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return
    const rect = root.getBoundingClientRect()
    if (event.clientX > rect.left && event.clientX < rect.right && event.clientY > rect.top && event.clientY < rect.bottom) return
    reset()
  }
  function outside(event: DragEvent) {
    if (root && event.target instanceof Node && !root.contains(event.target)) reset()
  }
  function leaveWindow(event: DragEvent) { if (!event.relatedTarget && (event.target === document || event.target === document.documentElement)) reset() }
  window.addEventListener('dragover', outside, true)
  window.addEventListener('dragleave', leaveWindow, true)
  window.addEventListener('drop', reset, true)
  window.addEventListener('dragend', reset, true)
  window.addEventListener('blur', reset)
  onScopeDispose(() => {
    window.removeEventListener('dragover', outside, true)
    window.removeEventListener('dragleave', leaveWindow, true)
    window.removeEventListener('drop', reset, true)
    window.removeEventListener('dragend', reset, true)
    window.removeEventListener('blur', reset)
    reset()
  })
  return { depth, active: computed(() => depth.value > 0), enter: over, over, leave, reset }
}
