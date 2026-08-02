export interface DragListenerOptions {
  pointer: boolean
  pointerId: number | null
  source: HTMLElement
  onMove: (event: PointerEvent | DragEvent) => void
  onEnd: () => void
}

/** 安装并集中清理单卡/多卡共用的 pointer 与原生 drag listener。 */
export function installDragListeners(options: DragListenerOptions): () => void {
  const { pointer, pointerId, source, onMove, onEnd } = options
  if (pointer) {
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onEnd)
    document.addEventListener('pointercancel', onEnd)
    try { document.body.setPointerCapture(pointerId!) } catch {}
  } else {
    document.addEventListener('dragover', onMove)
    document.addEventListener('drop', onEnd, true)
    source.addEventListener('dragend', onEnd)
  }

  return () => {
    if (pointer) {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onEnd)
      document.removeEventListener('pointercancel', onEnd)
      try { document.body.releasePointerCapture(pointerId!) } catch {}
    } else {
      document.removeEventListener('dragover', onMove)
      document.removeEventListener('drop', onEnd, true)
      source.removeEventListener('dragend', onEnd)
    }
  }
}
