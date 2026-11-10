const SCROLL_SURFACE_SELECTOR = [
  '.scroll-surface:not(.scroll-surface--hidden):not(.scrollbar-preview)',
  '.page-content',
  '.task-grid',
  '.col-body',
].join(',')

const HOST_CLASS = 'overlay-scroll-host'
const THUMB_ATTRIBUTE = 'data-overlay-scrollbar-thumb'
const TRACK_INSET_HEADER_SELECTOR = ':scope > [data-scrollbar-inset-header]'

type ScrollBinding = {
  thumb: HTMLDivElement
  resizeObserver: ResizeObserver
  onScroll: () => void
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
  owner: HTMLElement | null
  dragStartY: number | null
  dragStartScrollTop: number
}

const bindings = new WeakMap<HTMLElement, ScrollBinding>()

function getTrackGeometry(element: HTMLElement, { thumb, owner }: ScrollBinding) {
  const rect = element.getBoundingClientRect()
  const ownerRect = owner?.getBoundingClientRect()
  // 宿主内的滑块使用宿主的布局坐标。开合缩放期间，先把屏幕上的距离换回布局距离。
  const scaleX = owner && ownerRect && owner.offsetWidth ? ownerRect.width / owner.offsetWidth || 1 : 1
  const scaleY = owner && ownerRect && owner.offsetHeight ? ownerRect.height / owner.offsetHeight || 1 : 1
  const styles = getComputedStyle(thumb)
  const baseInset = Math.max(0, parseFloat(styles.getPropertyValue('--scrollbar-overlay-track-inset')) || 0)
  const insetHeader = element.querySelector<HTMLElement>(TRACK_INSET_HEADER_SELECTOR)
  const headerBottom = insetHeader
    ? Math.max(0, (insetHeader.getBoundingClientRect().bottom - rect.top) / scaleY)
    : 0
  const insetTop = headerBottom + baseInset
  return {
    top: (rect.top - (ownerRect?.top ?? 0)) / scaleY + insetTop,
    right: Math.max(0, ((ownerRect?.right ?? window.innerWidth) - rect.right) / scaleX),
    height: Math.max(0, rect.height / scaleY - insetTop - baseInset),
    minThumb: Math.max(1, parseFloat(styles.getPropertyValue('--scrollbar-min-thumb')) || 24),
    scaleY,
  }
}

function updateThumb(element: HTMLElement, binding: ScrollBinding) {
  const viewport = element.clientHeight
  const content = element.scrollHeight
  const { top, right, height: track, minThumb } = getTrackGeometry(element, binding)
  const maxScroll = content - viewport

  if (maxScroll <= 1 || track <= 1) {
    binding.thumb.hidden = true
    return
  }

  const thumbHeight = Math.min(track, Math.max(minThumb, (viewport / content) * track))
  const maxOffset = Math.max(0, track - thumbHeight)
  const offset = maxScroll > 0 ? (element.scrollTop / maxScroll) * maxOffset : 0
  binding.thumb.hidden = false
  binding.thumb.style.height = `${thumbHeight}px`
  binding.thumb.style.top = `${top + offset}px`
  binding.thumb.style.right = `calc(${right}px - var(--scrollbar-overlay-right-offset))`

  const modal = element.closest<HTMLElement>('.bm-center')
  if (modal) {
    const modalZ = Number.parseInt(getComputedStyle(modal).zIndex, 10)
    if (Number.isFinite(modalZ)) binding.thumb.style.zIndex = String(modalZ + 1)
  } else {
    const chatWindow = element.closest<HTMLElement>('.chat-window')
    if (chatWindow) {
      const chatZ = Number.parseInt(getComputedStyle(chatWindow).zIndex, 10)
      if (Number.isFinite(chatZ)) binding.thumb.style.zIndex = String(chatZ + 1)
    }
  }
}

function bind(element: HTMLElement) {
  if (bindings.has(element)) return

  element.classList.add(HOST_CLASS)
  const thumb = document.createElement('div')
  thumb.setAttribute(THUMB_ATTRIBUTE, '')
  thumb.setAttribute('aria-hidden', 'true')
  if (element.classList.contains('scroll-surface--compact')) thumb.classList.add('overlay-scrollbar--compact')
  if (element.classList.contains('scroll-surface--editor')) thumb.classList.add('overlay-scrollbar--editor')
  if (element.classList.contains('col-body')) thumb.classList.add('overlay-scrollbar--column')
  if (element.closest('.project-modal-root')) thumb.classList.add('overlay-scrollbar--modal')
  // Most offsets are owned by thumb variants (column/drawer). A specific scroll surface may opt in
  // through the same token; copy only non-zero surface values so the root 0px default does not
  // overwrite those thumb-variant contracts.
  const surfaceRightOffset = parseFloat(getComputedStyle(element).getPropertyValue('--scrollbar-overlay-right-offset'))
  if (Number.isFinite(surfaceRightOffset) && Math.abs(surfaceRightOffset) > 0.01) {
    thumb.style.setProperty('--scrollbar-overlay-right-offset', `${surfaceRightOffset}px`)
  }
  // 独立浮层作为滚动宿主时，把滑块挂在宿主内部以共享层级并跟随其动画；
  // 否则滑块会挂到 body，可能被浮层遮挡或在浮层淡出后残留。
  const owner = element.closest<HTMLElement>('.chat-window, .drawer-shell, .bm-card, .notif-popup, .gs-panel, .nb-item, .popup-menu-host')
  if (owner) thumb.classList.add('overlay-scrollbar--owner')
  if (element.closest('.drawer-shell')) thumb.classList.add('overlay-scrollbar--drawer')
  if (element.closest('.notif-popup')) thumb.classList.add('overlay-scrollbar--notif')
  const thumbHost = owner ?? document.body
  thumbHost.appendChild(thumb)

  const onScroll = () => {
    const binding = bindings.get(element)
    if (binding) updateThumb(element, binding)
  }
  const binding: ScrollBinding = {
    thumb,
    resizeObserver: new ResizeObserver(onScroll),
    onScroll,
    onPointerDown: () => {},
    onPointerMove: () => {},
    onPointerUp: () => {},
    owner,
    dragStartY: null,
    dragStartScrollTop: 0,
  }
  binding.onPointerDown = (event) => {
    if (event.button !== 0 || thumb.hidden) return
    event.preventDefault()
    event.stopPropagation()
    binding.dragStartY = event.clientY
    binding.dragStartScrollTop = element.scrollTop
    thumb.setPointerCapture(event.pointerId)
    thumb.classList.add('overlay-scrollbar--dragging')
  }
  binding.onPointerMove = (event) => {
    if (binding.dragStartY === null) return
    const { height, scaleY } = getTrackGeometry(element, binding)
    const thumbHeight = thumb.getBoundingClientRect().height
    const maxOffset = Math.max(1, height * scaleY - thumbHeight)
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
    element.scrollTop = binding.dragStartScrollTop + ((event.clientY - binding.dragStartY) / maxOffset) * maxScroll
  }
  binding.onPointerUp = (event) => {
    if (binding.dragStartY === null) return
    binding.dragStartY = null
    thumb.classList.remove('overlay-scrollbar--dragging')
    if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId)
  }
  thumb.addEventListener('pointerdown', binding.onPointerDown)
  thumb.addEventListener('pointermove', binding.onPointerMove)
  thumb.addEventListener('pointerup', binding.onPointerUp)
  thumb.addEventListener('pointercancel', binding.onPointerUp)
  bindings.set(element, binding)
  binding.resizeObserver.observe(element)
  binding.resizeObserver.observe(element.firstElementChild ?? element)
  element.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  updateThumb(element, binding)
}

function unbind(element: HTMLElement) {
  const binding = bindings.get(element)
  if (!binding) return

  binding.resizeObserver.disconnect()
  element.removeEventListener('scroll', binding.onScroll)
  window.removeEventListener('scroll', binding.onScroll)
  window.removeEventListener('resize', binding.onScroll)
  binding.thumb.removeEventListener('pointerdown', binding.onPointerDown)
  binding.thumb.removeEventListener('pointermove', binding.onPointerMove)
  binding.thumb.removeEventListener('pointerup', binding.onPointerUp)
  binding.thumb.removeEventListener('pointercancel', binding.onPointerUp)
  binding.thumb.remove()
  element.classList.remove(HOST_CLASS)
  bindings.delete(element)
}

function unbindTree(node: Node) {
  if (!(node instanceof HTMLElement)) return
  if (node.matches(SCROLL_SURFACE_SELECTOR)) unbind(node)
  node.querySelectorAll<HTMLElement>(SCROLL_SURFACE_SELECTOR).forEach(unbind)
}

function scan(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches(SCROLL_SURFACE_SELECTOR)) bind(root)
  root.querySelectorAll<HTMLElement>(SCROLL_SURFACE_SELECTOR).forEach(bind)
}

function refreshAncestor(element: HTMLElement | null) {
  let current = element
  while (current) {
    const binding = bindings.get(current)
    if (binding) updateThumb(current, binding)
    current = current.parentElement
  }
}

export function installOverlayScrollbars() {
  scan(document)
  let mutationFrame: number | null = null
  let pendingRecords: MutationRecord[] = []

  const withoutNestedRoots = (roots: HTMLElement[]): HTMLElement[] => {
    const unique = [...new Set(roots)]
    return unique.filter((root) => !unique.some((parent) => parent !== root && parent.contains(root)))
  }

  const flushMutations = (): void => {
    mutationFrame = null
    const records = pendingRecords
    pendingRecords = []

    const removedRoots = withoutNestedRoots(records.flatMap((record) => (
      [...record.removedNodes].filter((node): node is HTMLElement => node instanceof HTMLElement)
    )))
    const addedRoots = withoutNestedRoots(records.flatMap((record) => (
      [...record.addedNodes].filter((node): node is HTMLElement => node instanceof HTMLElement)
    )))

    removedRoots.forEach(unbindTree)

    const refreshedAncestors = new Set<HTMLElement>()
    addedRoots.forEach((node) => {
      scan(node)
      if (node.parentElement) refreshedAncestors.add(node.parentElement)
    })
    refreshedAncestors.forEach(refreshAncestor)
  }

  const scheduleMutationFlush = (): void => {
    if (mutationFrame !== null) return
    mutationFrame = requestAnimationFrame(flushMutations)
  }

  const observer = new MutationObserver((records) => {
    pendingRecords.push(...records)
    scheduleMutationFlush()
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  })
}
