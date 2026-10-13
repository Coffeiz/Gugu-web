import { createVNode, render } from 'vue'
import ViewerToolbar from '@/components/common/viewers/ViewerToolbar.vue'
import type { MermaidInteractionLabels } from '@/utils/mermaidInteraction'

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

  const body = document.createElement('div')
  body.className = 'md-mermaid-dialog-body'
  const clone = svg.cloneNode(true) as SVGSVGElement
  // 正文内的图表可能已经缩放或平移，弹窗预览应从原始视图开始。
  clone.style.transform = ''
  clone.style.transformOrigin = ''
  clone.style.cursor = 'default'
  clone.style.maxWidth = '100%'
  clone.style.maxHeight = '100%'
  body.append(clone)
  const toolbarHost = document.createElement('div')
  toolbarHost.className = 'iv-toolbar-host'
  body.append(toolbarHost)
  dialog.append(body)

  let scale = 1
  let offsetX = 0
  let offsetY = 0
  let dragStart: { x: number; y: number; offsetX: number; offsetY: number } | null = null
  const setScale = (nextScale: number) => {
    // 工具栏显示整数百分比；落在 100% 的舍入误差范围时也统一回到居中基准。
    scale = nextScale <= 1.005 ? 1 : nextScale
    if (scale <= 1) offsetX = offsetY = 0
    updateView()
  }
  const updateView = () => {
    clone.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
    clone.style.transformOrigin = 'center center'
    clone.style.cursor = dragStart ? 'grabbing' : 'grab'
    render(createVNode(ViewerToolbar, {
      ariaLabel: labels.previewTitle,
      zoomPercent: Math.round(scale * 100),
      zoomOutLabel: labels.zoomOut,
      resetZoomLabel: labels.resetZoom,
      zoomInLabel: labels.zoomIn,
      showDownload: true,
      downloadLabel: labels.downloadPng,
      showClose: true,
      closeLabel: labels.close,
      onZoomOut: () => setScale(Math.max(0.1, scale / 1.25)),
      onResetZoom: () => setScale(1),
      onZoomIn: () => setScale(Math.min(8, scale * 1.25)),
      onDownload: () => {
        const cleanClone = clone.cloneNode(true) as SVGSVGElement
        cleanClone.style.transform = ''
        cleanClone.style.transformOrigin = ''
        onDownload(cleanClone, dialog)
      },
      onClose: close,
    }), toolbarHost)
  }

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    document.removeEventListener('click', onDocumentClick, true)
    render(null, toolbarHost)
    if (dialog.open && typeof dialog.close === 'function') dialog.close()
    dialog.remove()
    returnFocus?.focus()
  }
  const onDocumentClick = (event: MouseEvent) => {
    const target = event.target
    if (!dialog.open || target === dialog || (target instanceof Node && dialog.contains(target))) return
    // 原生 dialog 的背景点有时会被底层弹窗遮罩命中；在 capture 阶段拦截，避免关闭父预览。
    event.preventDefault()
    event.stopImmediatePropagation()
    close()
  }
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.iv-toolbar')) return
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    dragStart = { x: event.clientX, y: event.clientY, offsetX, offsetY }
    body.setPointerCapture(event.pointerId)
    updateView()
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!dragStart) return
    offsetX = dragStart.offsetX + event.clientX - dragStart.x
    offsetY = dragStart.offsetY + event.clientY - dragStart.y
    updateView()
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!dragStart) return
    dragStart = null
    if (body.hasPointerCapture(event.pointerId)) body.releasePointerCapture(event.pointerId)
    updateView()
  }
  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    setScale(Math.min(8, Math.max(0.1, scale * (event.deltaY > 0 ? 0.9 : 1.1))))
  }
  body.addEventListener('pointerdown', onPointerDown)
  body.addEventListener('pointermove', onPointerMove)
  body.addEventListener('pointerup', onPointerUp)
  body.addEventListener('pointercancel', onPointerUp)
  body.addEventListener('wheel', onWheel, { passive: false })
  dialog.addEventListener('click', event => {
    // 该对话框叠在文件预览器之上，空白处关闭不能继续触发底层预览器的点击处理。
    event.stopPropagation()
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
  updateView()

  document.body.append(dialog)
  if (typeof dialog.showModal === 'function') dialog.showModal()
  else dialog.setAttribute('open', '')
  document.addEventListener('click', onDocumentClick, true)
  toolbarHost.querySelector<HTMLButtonElement>('.iv-tb-close')?.focus()
  return close
}
