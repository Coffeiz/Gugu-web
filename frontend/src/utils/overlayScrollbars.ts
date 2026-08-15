const SCROLL_SURFACE_SELECTOR = [
  '.scroll-surface:not(.scroll-surface--hidden):not(.scrollbar-preview)',
  '.page-content',
  '.task-grid',
  '.col-body',
].join(',')

const HOST_CLASS = 'overlay-scroll-host'
const THUMB_ATTRIBUTE = 'data-overlay-scrollbar-thumb'

type ScrollBinding = {
  thumb: HTMLDivElement
  resizeObserver: ResizeObserver
  onScroll: () => void
}

const bindings = new WeakMap<HTMLElement, ScrollBinding>()

function updateThumb(element: HTMLElement, binding: ScrollBinding) {
  const viewport = element.clientHeight
  const content = element.scrollHeight
  const rect = element.getBoundingClientRect()
  const styles = getComputedStyle(binding.thumb)
  const trackInset = Math.max(0, parseFloat(styles.getPropertyValue('--scrollbar-overlay-track-inset')) || 0)
  const minThumb = Math.max(1, parseFloat(styles.getPropertyValue('--scrollbar-min-thumb')) || 24)
  const track = Math.max(0, rect.height - trackInset * 2)
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
  binding.thumb.style.top = `${rect.top + trackInset + offset}px`
  binding.thumb.style.right = `calc(${Math.max(0, window.innerWidth - rect.right)}px - var(--scrollbar-overlay-right-offset))`

  const modal = element.closest<HTMLElement>('.bm-center')
  if (modal) {
    const modalZ = Number.parseInt(getComputedStyle(modal).zIndex, 10)
    if (Number.isFinite(modalZ)) binding.thumb.style.zIndex = String(modalZ + 1)
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
  document.body.appendChild(thumb)

  const onScroll = () => {
    const binding = bindings.get(element)
    if (binding) updateThumb(element, binding)
  }
  const resizeObserver = new ResizeObserver(onScroll)
  resizeObserver.observe(element)
  resizeObserver.observe(element.firstElementChild ?? element)

  const binding = { thumb, resizeObserver, onScroll }
  bindings.set(element, binding)
  element.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  updateThumb(element, binding)
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
  const observer = new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node instanceof HTMLElement) {
        scan(node)
        refreshAncestor(node.parentElement)
      }
    }))
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
