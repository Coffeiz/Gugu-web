import { afterEach, describe, expect, it } from 'vitest'
import { bindMermaidInteractions, cleanupMermaidInteractions, type MermaidInteractionLabels } from '@/utils/mermaidInteraction'

const labels: MermaidInteractionLabels = {
  zoomOut: 'Zoom out', zoomIn: 'Zoom in', resetZoom: 'Reset', expand: 'Expand',
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

    dialog?.querySelector<HTMLButtonElement>('[data-mermaid-action="close-dialog"]')?.click()
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
