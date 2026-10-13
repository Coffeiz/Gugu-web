import { createVNode, render } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import type { IconName } from '@/components/common/icons/iconRegistry'
import { downloadMermaidPng } from '@/utils/mermaidPng'
import { openMermaidPreview } from '@/utils/mermaidPreview'

export type MermaidInteractionLabels = {
  zoomOut: string
  zoomIn: string
  resetZoom: string
  showSource: string
  showDiagram: string
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

function makeButton(action: string, label: string, icon: string | { name: IconName }): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.mermaidAction = action
  button.setAttribute('aria-label', label)
  button.title = label
  if (typeof icon !== 'string') {
    button.dataset.mermaidIcon = icon.name
    render(createVNode(Icon, { name: icon.name, size: 16 }), button)
  } else {
    button.textContent = icon
  }
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
  private sourceView: HTMLPreElement | null = null
  private sourceVisible = false
  private originalSvgDisplay = ''

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
    container.querySelectorAll<HTMLButtonElement>('.md-mermaid-controls [data-mermaid-icon]').forEach(button => {
      render(null, button)
    })
    this.setSourceVisible(false)
    this.sourceView?.remove()
    this.sourceView = null
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
        makeButton('zoom-out', this.labels.zoomOut, '−'),
        makeButton('zoom-in', this.labels.zoomIn, '+'),
        makeButton('reset', this.labels.resetZoom, '↺'),
        makeButton('toggle-source', this.labels.showSource, '</>'),
        makeButton('expand', this.labels.expand, '⛶'),
        makeButton('download-png', this.labels.downloadPng, { name: 'action.download' }),
      )
      controls.addEventListener('click', this.onControlClick)
      controls.addEventListener('dblclick', event => event.stopPropagation())
      this.container.append(controls)
    }
    const labels: Record<string, string> = {
      'zoom-out': this.labels.zoomOut,
      'zoom-in': this.labels.zoomIn,
      reset: this.labels.resetZoom,
      'toggle-source': this.sourceVisible ? this.labels.showDiagram : this.labels.showSource,
      expand: this.labels.expand,
      'download-png': this.labels.downloadPng,
    }
    controls.querySelectorAll<HTMLButtonElement>('[data-mermaid-action]').forEach(button => {
      const label = labels[button.dataset.mermaidAction || '']
      if (!label) return
      button.setAttribute('aria-label', label)
      button.title = label
      if (button.dataset.mermaidAction === 'toggle-source') {
        button.setAttribute('aria-pressed', String(this.sourceVisible))
        button.classList.toggle('active', this.sourceVisible)
      }
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
    if (action === 'toggle-source') this.setSourceVisible(!this.sourceVisible)
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

  private setSourceVisible(visible: boolean): void {
    const svg = this.getSvg()
    if (!svg) return
    if (!this.sourceView) {
      this.sourceView = document.createElement('pre')
      this.sourceView.className = 'md-mermaid-source-view'
      const code = document.createElement('code')
      try {
        code.textContent = decodeURIComponent(this.container.dataset.source || '')
      } catch {
        code.textContent = this.container.dataset.source || ''
      }
      this.sourceView.append(code)
      this.sourceView.style.display = 'none'
      this.container.append(this.sourceView)
      this.originalSvgDisplay = svg.style.display
    }
    this.sourceVisible = visible
    svg.style.display = visible ? 'none' : this.originalSvgDisplay
    this.sourceView.style.display = visible ? 'block' : 'none'
    const button = this.container.querySelector<HTMLButtonElement>(
      '.md-mermaid-controls [data-mermaid-action="toggle-source"]',
    )
    if (button) {
      const label = visible ? this.labels.showDiagram : this.labels.showSource
      button.setAttribute('aria-label', label)
      button.title = label
      button.setAttribute('aria-pressed', String(visible))
      button.classList.toggle('active', visible)
    }
  }

  private openPreview(): void {
    const svg = this.getSvg()
    if (!svg) return
    const current = document.querySelector<HTMLDialogElement>('.md-mermaid-dialog')
    if (current) {
      current.focus()
      return
    }
    let source = ''
    try {
      source = decodeURIComponent(this.container.dataset.source || '')
    } catch {
      source = this.container.dataset.source || ''
    }
    this.closePreview = openMermaidPreview(svg, this.labels, source, (clone, dialog) => {
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
    if (
      event.button !== 0
      || this.scale <= 1
      || (event.target as HTMLElement).closest('.md-mermaid-controls, .md-mermaid-source-view')
    ) return
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
