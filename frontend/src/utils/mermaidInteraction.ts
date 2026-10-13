import { downloadMermaidPng } from '@/utils/mermaidPng'
import { openMermaidPreview } from '@/utils/mermaidPreview'

export type MermaidInteractionLabels = {
  zoomOut: string
  zoomIn: string
  resetZoom: string
  expand: string
  downloadPng: string
  close: string
  previewTitle: string
  downloadFailed: string
  pngTooLarge: string
}

type MermaidBinding = { refresh: (labels: MermaidInteractionLabels) => void; cleanup: () => void }

const bindings = new WeakMap<HTMLElement, MermaidBinding>()
const MIN_SCALE = 0.5
const MAX_SCALE = 3

function makeButton(action: string, icon: string, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.mermaidAction = action
  button.setAttribute('aria-label', label)
  button.title = label
  button.textContent = icon
  return button
}

class MermaidInteractionBinding implements MermaidBinding {
  private labels: MermaidInteractionLabels
  private scale = 1
  private offsetX = 0
  private offsetY = 0
  private dragging = false
  private startX = 0
  private startY = 0
  private startOffsetX = 0
  private startOffsetY = 0
  private closePreview: (() => void) | null = null

  constructor(private readonly container: HTMLElement, labels: MermaidInteractionLabels) {
    this.labels = labels
    container.addEventListener('pointerdown', this.onPointerDown)
    container.addEventListener('pointermove', this.onPointerMove)
    container.addEventListener('pointerup', this.onPointerUp)
    container.addEventListener('pointercancel', this.onPointerUp)
    container.addEventListener('dblclick', this.onDoubleClick)
    this.refresh(labels)
  }

  refresh(labels: MermaidInteractionLabels): void {
    this.labels = labels
    const svg = this.getSvg()
    if (!svg) return
    this.ensureControls()
    svg.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`
    svg.style.transformOrigin = 'center center'
    svg.style.cursor = this.dragging ? 'grabbing' : this.scale > 1 ? 'grab' : 'default'
  }

  cleanup(): void {
    const { container } = this
    container.removeEventListener('pointerdown', this.onPointerDown)
    container.removeEventListener('pointermove', this.onPointerMove)
    container.removeEventListener('pointerup', this.onPointerUp)
    container.removeEventListener('pointercancel', this.onPointerUp)
    container.removeEventListener('dblclick', this.onDoubleClick)
    container.querySelector('.md-mermaid-controls')?.remove()
    container.querySelector('.md-mermaid-status')?.remove()
    this.closePreview?.()
    this.closePreview = null
    bindings.delete(container)
  }

  private getSvg(): SVGSVGElement | null {
    return this.container.querySelector('svg')
  }

  private ensureControls(): void {
    let controls = this.container.querySelector<HTMLElement>('.md-mermaid-controls')
    if (!controls) {
      controls = document.createElement('div')
      controls.className = 'md-mermaid-controls'
      controls.append(
        makeButton('zoom-out', '−', this.labels.zoomOut),
        makeButton('zoom-in', '+', this.labels.zoomIn),
        makeButton('reset', '↺', this.labels.resetZoom),
        makeButton('expand', '⛶', this.labels.expand),
        makeButton('download-png', '↓', this.labels.downloadPng),
      )
      controls.addEventListener('click', this.onControlClick)
      controls.addEventListener('dblclick', event => event.stopPropagation())
      this.container.append(controls)
    }
    const labels: Record<string, string> = {
      'zoom-out': this.labels.zoomOut,
      'zoom-in': this.labels.zoomIn,
      reset: this.labels.resetZoom,
      expand: this.labels.expand,
      'download-png': this.labels.downloadPng,
    }
    controls.querySelectorAll<HTMLButtonElement>('[data-mermaid-action]').forEach(button => {
      const label = labels[button.dataset.mermaidAction || '']
      if (!label) return
      button.setAttribute('aria-label', label)
      button.title = label
    })
  }

  private readonly onControlClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    const action = button?.dataset.mermaidAction
    if (!action) return
    event.stopPropagation()
    this.applyAction(action)
  }

  private applyAction(action: string): void {
    if (action === 'zoom-out') this.scale = Math.max(MIN_SCALE, this.scale * 0.8)
    if (action === 'zoom-in') this.scale = Math.min(MAX_SCALE, this.scale * 1.25)
    if (action === 'reset') this.resetView()
    if (action === 'expand') this.openPreview()
    if (action === 'download-png') {
      const svg = this.getSvg()
      if (svg) void this.download(svg, this.container)
    }
    this.refresh(this.labels)
  }

  private resetView(): void {
    this.scale = 1
    this.offsetX = 0
    this.offsetY = 0
  }

  private openPreview(): void {
    const svg = this.getSvg()
    if (!svg) return
    const current = document.querySelector<HTMLDialogElement>('.md-mermaid-dialog')
    if (current) {
      current.focus()
      return
    }
    this.closePreview = openMermaidPreview(svg, this.labels, (clone, dialog) => {
      void this.download(clone, dialog)
    })
  }

  private async download(svg: SVGSVGElement, target: HTMLElement): Promise<void> {
    try {
      await downloadMermaidPng(svg)
      target.querySelector('.md-mermaid-status')?.remove()
    } catch (error) {
      this.showError(error, target)
    }
  }

  private showError(error: unknown, target: HTMLElement): void {
    const status = target.querySelector<HTMLElement>('.md-mermaid-status') || document.createElement('span')
    status.className = 'md-mermaid-status'
    status.setAttribute('role', 'status')
    status.textContent = error instanceof Error && error.message === 'png_too_large'
      ? this.labels.pngTooLarge
      : this.labels.downloadFailed
    if (!status.isConnected) target.append(status)
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.scale <= 1 || (event.target as HTMLElement).closest('.md-mermaid-controls')) return
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    this.dragging = true
    this.startX = event.clientX
    this.startY = event.clientY
    this.startOffsetX = this.offsetX
    this.startOffsetY = this.offsetY
    this.container.setPointerCapture(event.pointerId)
    this.container.classList.add('md-mermaid-dragging')
    this.refresh(this.labels)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return
    this.offsetX = this.startOffsetX + event.clientX - this.startX
    this.offsetY = this.startOffsetY + event.clientY - this.startY
    this.refresh(this.labels)
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return
    this.dragging = false
    if (this.container.hasPointerCapture(event.pointerId)) this.container.releasePointerCapture(event.pointerId)
    this.container.classList.remove('md-mermaid-dragging')
    this.refresh(this.labels)
  }

  private readonly onDoubleClick = (): void => {
    this.resetView()
    this.refresh(this.labels)
  }
}

export function bindMermaidInteractions(container: HTMLElement, labels: MermaidInteractionLabels): void {
  const existing = bindings.get(container)
  if (existing) {
    existing.refresh(labels)
    return
  }
  const binding = new MermaidInteractionBinding(container, labels)
  bindings.set(container, binding)
}

export function cleanupMermaidInteractions(root: HTMLElement | null): void {
  if (!root) return
  const containers = root.matches('.md-mermaid')
    ? [root, ...root.querySelectorAll<HTMLElement>('.md-mermaid')]
    : [...root.querySelectorAll<HTMLElement>('.md-mermaid')]
  containers.forEach(container => bindings.get(container)?.cleanup())
}
