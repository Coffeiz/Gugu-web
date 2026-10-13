import type { MermaidInteractionLabels } from '@/utils/mermaidInteraction'

function makeButton(action: string, icon: string, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.mermaidAction = action
  button.setAttribute('aria-label', label)
  button.title = label
  button.textContent = icon
  return button
}

/** 创建独立原生对话框，返回可用于卸载清理的关闭函数。 */
export function openMermaidPreview(
  svg: SVGSVGElement,
  labels: MermaidInteractionLabels,
  onDownload: (svg: SVGSVGElement, dialog: HTMLDialogElement) => void,
): () => void {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const dialog = document.createElement('dialog')
  dialog.className = 'md-mermaid-dialog'
  dialog.setAttribute('aria-label', labels.previewTitle)
  dialog.setAttribute('aria-modal', 'true')

  const header = document.createElement('header')
  const title = document.createElement('strong')
  title.textContent = labels.previewTitle
  const actions = document.createElement('div')
  actions.className = 'md-mermaid-dialog-actions'
  const exportButton = makeButton('download-png', '↓', labels.downloadPng)
  const closeButton = makeButton('close-dialog', '×', labels.close)
  actions.append(exportButton, closeButton)
  header.append(title, actions)

  const body = document.createElement('div')
  body.className = 'md-mermaid-dialog-body'
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.style.transform = ''
  clone.style.transformOrigin = ''
  body.append(clone)
  dialog.append(header, body)

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    if (dialog.open && typeof dialog.close === 'function') dialog.close()
    dialog.remove()
    returnFocus?.focus()
  }
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close()
  })
  dialog.addEventListener('cancel', event => {
    event.preventDefault()
    close()
  })
  dialog.addEventListener('close', () => {
    if (!closed) {
      closed = true
      returnFocus?.focus()
    }
    dialog.remove()
  }, { once: true })
  closeButton.addEventListener('click', close)
  exportButton.addEventListener('click', () => onDownload(clone, dialog))

  document.body.append(dialog)
  if (typeof dialog.showModal === 'function') dialog.showModal()
  else dialog.setAttribute('open', '')
  closeButton.focus()
  return close
}
