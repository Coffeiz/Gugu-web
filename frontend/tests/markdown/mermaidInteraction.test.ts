import { afterEach, describe, expect, it } from 'vitest'
import { bindMermaidInteractions, cleanupMermaidInteractions, type MermaidInteractionLabels } from '@/utils/mermaidInteraction'

const labels: MermaidInteractionLabels = {
  zoomOut: 'Zoom out', zoomIn: 'Zoom in', resetZoom: 'Reset', expand: 'Expand',
  showSource: 'Show source', showDiagram: 'Show diagram',
  downloadPng: 'Download PNG', close: 'Close', previewTitle: 'Diagram preview',
  downloadFailed: 'Download failed', pngTooLarge: 'Diagram too large',
}

let root: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    cleanupMermaidInteractions(root)
    root.remove()
    root = null
  }
  document.querySelectorAll('.md-mermaid-dialog').forEach(dialog => dialog.remove())
})

describe('Mermaid preview interactions', () => {
  it('renders the PNG download action with the shared accessible icon', () => {
    root = document.createElement('div')
    const chart = document.createElement('div')
    chart.className = 'md-mermaid'
    chart.innerHTML = '<svg viewBox="0 0 20 20"><circle r="4" /></svg>'
    root.append(chart)
    document.body.append(root)

    bindMermaidInteractions(chart, labels)

    const downloadButton = chart.querySelector<HTMLButtonElement>('[data-mermaid-action="download-png"]')!
    expect(downloadButton.getAttribute('aria-label')).toBe(labels.downloadPng)
    expect(downloadButton.querySelector('svg.app-icon')).not.toBeNull()
    expect(downloadButton.textContent).toBe('')
  })

  it('opens an accessible full-size preview and closes it from the control', () => {
    root = document.createElement('div')
    const chart = document.createElement('div')
    chart.className = 'md-mermaid'
    chart.innerHTML = '<svg viewBox="0 0 120 80"><rect width="120" height="80" /></svg>'
    root.append(chart)
    document.body.append(root)

    bindMermaidInteractions(chart, labels)
    const expandButton = chart.querySelector<HTMLButtonElement>('[data-mermaid-action="expand"]')!
    expandButton.focus()
    expandButton.click()

    const dialog = document.querySelector<HTMLDialogElement>('.md-mermaid-dialog')
    expect(dialog?.getAttribute('aria-label')).toBe(labels.previewTitle)
    expect(dialog?.querySelector('svg rect')?.getAttribute('width')).toBe('120')
    expect(dialog?.querySelector('header')).toBeNull()
    expect(dialog?.querySelector('.iv-toolbar')).not.toBeNull()
    expect(dialog?.querySelector('.iv-tb-pct')?.textContent?.trim()).toBe('100%')
    expect(dialog?.querySelector('.iv-tb-close')?.getAttribute('title')).toBe(labels.close)
    expect(dialog?.querySelector('.iv-toolbar .iv-tb-btn[title="Download PNG"]')).not.toBeNull()

    dialog?.querySelector<HTMLButtonElement>(`.iv-tb-btn[title="${labels.zoomIn}"]`)?.click()
    expect(dialog?.querySelector('.iv-tb-pct')?.textContent?.trim()).toBe('125%')
    dialog?.querySelector('.iv-tb-pct')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(dialog?.querySelector('.iv-tb-pct')?.textContent?.trim()).toBe('100%')

    dialog?.querySelector<HTMLButtonElement>('.iv-tb-close')?.click()
    expect(document.querySelector('.md-mermaid-dialog')).toBeNull()
    expect(document.activeElement).toBe(expandButton)
  })

  it('supports the dialog cancel path used by Escape', () => {
    root = document.createElement('div')
    const chart = document.createElement('div')
    chart.className = 'md-mermaid'
    chart.innerHTML = '<svg viewBox="0 0 20 20"><circle r="4" /></svg>'
    root.append(chart)
    document.body.append(root)
    bindMermaidInteractions(chart, labels)
    chart.querySelector<HTMLButtonElement>('[data-mermaid-action="expand"]')?.click()

    const dialog = document.querySelector<HTMLDialogElement>('.md-mermaid-dialog')!
    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)

    expect(cancel.defaultPrevented).toBe(true)
    expect(document.querySelector('.md-mermaid-dialog')).toBeNull()
  })

  it('isolates backdrop clicks so closing Mermaid preview does not close its parent viewer', () => {
    root = document.createElement('div')
    const chart = document.createElement('div')
    chart.className = 'md-mermaid'
    chart.innerHTML = '<svg viewBox="0 0 20 20"><circle r="4" /></svg>'
    root.append(chart)
    document.body.append(root)
    bindMermaidInteractions(chart, labels)
    chart.querySelector<HTMLButtonElement>('[data-mermaid-action="expand"]')?.click()

    let parentClickObserved = false
    const onParentClick = () => { parentClickObserved = true }
    root.addEventListener('click', onParentClick)
    // 模拟 backdrop 点击穿透到父预览遮罩，而非命中 dialog 自身。
    root.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    root.removeEventListener('click', onParentClick)

    expect(parentClickObserved).toBe(false)
    expect(document.querySelector('.md-mermaid-dialog')).toBeNull()
  })

  it('prevents text selection while dragging and recenters when zoom returns to 100 percent', () => {
    root = document.createElement('div')
    const chart = document.createElement('div')
    chart.className = 'md-mermaid'
    chart.innerHTML = '<svg viewBox="0 0 120 80"><text>diagram</text></svg>'
    root.append(chart)
    document.body.append(root)
    bindMermaidInteractions(chart, labels)
    chart.querySelector<HTMLButtonElement>('[data-mermaid-action="expand"]')?.click()

    const dialog = document.querySelector<HTMLDialogElement>('.md-mermaid-dialog')!
    const body = dialog.querySelector<HTMLElement>('.md-mermaid-dialog-body')!
    const svg = dialog.querySelector<SVGSVGElement>('svg')!
    body.setPointerCapture = () => {}
    body.hasPointerCapture = () => true
    body.releasePointerCapture = () => {}

    const dispatchPointer = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent
      Object.defineProperties(event, {
        button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y },
      })
      svg.dispatchEvent(event)
      return event
    }

    dialog.querySelector<HTMLButtonElement>(`.iv-tb-btn[title="${labels.zoomIn}"]`)?.click()
    expect(dispatchPointer('pointerdown', 10, 10).defaultPrevented).toBe(true)
    dispatchPointer('pointermove', 30, 40)
    dispatchPointer('pointerup', 30, 40)
    expect(svg.style.transform).toBe('translate(20px, 30px) scale(1.25)')

    dialog.querySelector<HTMLButtonElement>(`.iv-tb-btn[title="${labels.zoomOut}"]`)?.click()
    expect(svg.style.transform).toBe('translate(0px, 0px) scale(1)')

    // 100% 下仍能按图片浏览器的交互方式拖动，但不会选中图中文字。
    expect(dispatchPointer('pointerdown', 10, 10).defaultPrevented).toBe(true)
    dispatchPointer('pointermove', 15, 20)
    dispatchPointer('pointerup', 15, 20)
    expect(svg.style.transform).toBe('translate(5px, 10px) scale(1)')
  })

  it('unmount cleanup removes controls and any open preview', () => {
    root = document.createElement('div')
    const chart = document.createElement('div')
    chart.className = 'md-mermaid'
    chart.innerHTML = '<svg viewBox="0 0 20 20"><circle r="4" /></svg>'
    root.append(chart)
    document.body.append(root)
    bindMermaidInteractions(chart, labels)
    chart.querySelector<HTMLButtonElement>('[data-mermaid-action="expand"]')?.click()

    cleanupMermaidInteractions(chart)

    expect(chart.querySelector('.md-mermaid-controls')).toBeNull()
    expect(document.querySelector('.md-mermaid-dialog')).toBeNull()
  })
})
