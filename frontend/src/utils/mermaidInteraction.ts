type MermaidBinding = {
  refresh: () => void
  cleanup: () => void
}

const bindings = new WeakMap<HTMLElement, MermaidBinding>()

const MIN_SCALE = 0.5
const MAX_SCALE = 3

export function bindMermaidInteractions(container: HTMLElement): void {
  const existing = bindings.get(container)
  if (existing) {
    existing.refresh()
    return
  }

  let scale = 1
  let offsetX = 0
  let offsetY = 0
  let dragging = false
  let startX = 0
  let startY = 0
  let startOffsetX = 0
  let startOffsetY = 0

  const getSvg = () => container.querySelector<SVGElement>('svg')
  const refresh = () => {
    const svg = getSvg()
    if (!svg) return
    ensureControls()
    svg.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
    svg.style.transformOrigin = 'center center'
    svg.style.cursor = dragging ? 'grabbing' : scale > 1 ? 'grab' : 'default'
  }
  const reset = () => {
    scale = 1
    offsetX = 0
    offsetY = 0
    refresh()
  }
  const changeScale = (factor: number) => {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor))
    refresh()
  }
  const ensureControls = () => {
    if (container.querySelector('.md-mermaid-controls')) return
    const controls = document.createElement('div')
    controls.className = 'md-mermaid-controls'
    controls.innerHTML = `
      <button type="button" data-mermaid-action="zoom-out" aria-label="缩小图表" title="缩小">−</button>
      <button type="button" data-mermaid-action="zoom-in" aria-label="放大图表" title="放大">＋</button>
      <button type="button" data-mermaid-action="reset" aria-label="恢复图表大小" title="复位">↺</button>
    `
    controls.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.mermaidAction
      if (!action) return
      event.stopPropagation()
      if (action === 'zoom-out') changeScale(0.8)
      if (action === 'zoom-in') changeScale(1.25)
      if (action === 'reset') reset()
    })
    container.appendChild(controls)
  }
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || scale <= 1 || (event.target as HTMLElement).closest('.md-mermaid-controls')) return
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    dragging = true
    startX = event.clientX
    startY = event.clientY
    startOffsetX = offsetX
    startOffsetY = offsetY
    container.setPointerCapture(event.pointerId)
    container.classList.add('md-mermaid-dragging')
    refresh()
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return
    offsetX = startOffsetX + event.clientX - startX
    offsetY = startOffsetY + event.clientY - startY
    refresh()
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!dragging) return
    dragging = false
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId)
    container.classList.remove('md-mermaid-dragging')
    refresh()
  }
  const onDoubleClick = () => reset()
  const cleanup = () => {
    container.removeEventListener('pointerdown', onPointerDown)
    container.removeEventListener('pointermove', onPointerMove)
    container.removeEventListener('pointerup', onPointerUp)
    container.removeEventListener('pointercancel', onPointerUp)
    container.removeEventListener('dblclick', onDoubleClick)
    container.querySelector('.md-mermaid-controls')?.remove()
    bindings.delete(container)
  }

  container.addEventListener('pointerdown', onPointerDown)
  container.addEventListener('pointermove', onPointerMove)
  container.addEventListener('pointerup', onPointerUp)
  container.addEventListener('pointercancel', onPointerUp)
  container.addEventListener('dblclick', onDoubleClick)
  bindings.set(container, { refresh, cleanup })
  refresh()
}

export function cleanupMermaidInteractions(root: HTMLElement | null): void {
  if (!root) return
  root.querySelectorAll<HTMLElement>('.md-mermaid').forEach((container) => bindings.get(container)?.cleanup())
}
