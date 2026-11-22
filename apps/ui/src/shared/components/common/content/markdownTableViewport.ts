import './markdownTableViewport.css'

function scrollViewport(content: HTMLElement): HTMLElement {
  for (let ancestor = content.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(ancestor).overflowY)) return ancestor
  }
  return document.documentElement
}

function cloneHeader(table: HTMLTableElement): HTMLTableElement {
  const clone = table.cloneNode(false) as HTMLTableElement
  for (const part of table.querySelectorAll(':scope > colgroup, :scope > thead')) clone.append(part.cloneNode(true))
  clone.removeAttribute('id')
  clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
  clone.style.width = clone.style.minWidth = `${table.getBoundingClientRect().width}px`
  const cells = clone.querySelectorAll<HTMLElement>('thead :is(th, td)')
  table.querySelectorAll<HTMLElement>('thead :is(th, td)').forEach((cell, index) => {
    const target = cells[index]
    if (!target) return
    const style = getComputedStyle(cell)
    for (const property of ['font', 'color', 'background-color', 'text-align', 'vertical-align', 'padding', 'border', 'white-space', 'line-height']) {
      target.style.setProperty(property, style.getPropertyValue(property))
    }
    target.style.width = `${cell.getBoundingClientRect().width}px`
    target.style.boxSizing = 'border-box'
  })
  return clone
}

export function createMarkdownTableViewport(host: HTMLElement, content: HTMLElement, viewport = scrollViewport(content), label = '横向滚动表格') {
  // 将控件挂在滚动区外，避免虚拟行先滚动、下一帧才补偿控件位置。
  const overlayHost = viewport.parentElement?.matches('[data-markdown-table-overlay-host]') ? viewport.parentElement : host
  const header = document.createElement('div')
  header.className = 'md-floating-table-head'
  header.hidden = true
  header.inert = true
  header.setAttribute('aria-hidden', 'true')

  const scrollbar = document.createElement('div')
  scrollbar.className = 'md-floating-table-scroll'
  scrollbar.hidden = true
  scrollbar.tabIndex = 0
  scrollbar.setAttribute('role', 'region')
  scrollbar.setAttribute('aria-label', label)
  const track = document.createElement('div')
  scrollbar.append(track)

  let tables: HTMLTableElement[] = []
  let shownHeader: HTMLTableElement | undefined
  let scroller: HTMLElement | undefined
  let frame = 0
  function update() {
    frame = 0
    if (!host.isConnected) return
    const bounds = viewport.getBoundingClientRect()
    const origin = overlayHost.getBoundingClientRect()
    const top = viewport === document.documentElement ? 0 : Math.max(0, bounds.top + viewport.clientTop)
    const bottom = viewport === document.documentElement ? window.innerHeight : Math.min(window.innerHeight, bounds.top + viewport.clientTop + viewport.clientHeight)
    let pinned: HTMLTableElement | undefined
    let wide: HTMLElement | undefined
    for (const table of tables) {
      const wrapper = table.parentElement!
      const rect = wrapper.getBoundingClientRect()
      if (top < bottom && rect.top < top && rect.bottom > top && table.tHead
        && table.tHead.getBoundingClientRect().top < top) pinned ??= table
      if (top < bottom && rect.top < bottom && rect.bottom > bottom && wrapper.scrollWidth > wrapper.clientWidth + 1) wide ??= wrapper
    }
    header.hidden = !pinned
    if (pinned) {
      const wrapper = pinned.parentElement!
      if (shownHeader !== pinned) header.replaceChildren(cloneHeader(pinned))
      const height = pinned.tHead!.getBoundingClientRect().height
      const visible = Math.min(height, wrapper.getBoundingClientRect().bottom - top)
      header.style.top = `${top - origin.top - overlayHost.clientTop}px`
      header.style.left = `${wrapper.getBoundingClientRect().left - origin.left - overlayHost.clientLeft}px`
      header.style.width = `${wrapper.clientWidth}px`
      header.style.height = `${visible}px`
      const clone = header.firstElementChild as HTMLElement
      clone.style.transform = `translate(${-wrapper.scrollLeft}px, ${visible - height}px)`
    } else if (shownHeader) header.replaceChildren()
    shownHeader = pinned

    scrollbar.hidden = !wide
    scroller = wide
    if (wide) {
      track.style.width = `${wide.scrollWidth}px`
      scrollbar.style.width = `${wide.clientWidth}px`
      scrollbar.style.left = `${wide.getBoundingClientRect().left - origin.left - overlayHost.clientLeft}px`
      scrollbar.style.top = `${bottom - origin.top - overlayHost.clientTop - scrollbar.offsetHeight}px`
      if (scrollbar.scrollLeft !== wide.scrollLeft) scrollbar.scrollLeft = wide.scrollLeft
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update)
  }
  function refresh() {
    tables = Array.from(content.querySelectorAll<HTMLTableElement>('table'))
      .filter(table => !table.closest('.md-floating-table-head') && table.parentElement?.matches('.md-table-scroll, .md-table-wrap'))
    shownHeader = undefined
    if (!overlayHost.contains(header)) overlayHost.append(header, scrollbar)
    schedule()
  }
  function syncScroll() {
    if (scroller && scrollbar.scrollLeft !== scroller.scrollLeft) scroller.scrollLeft = scrollbar.scrollLeft
  }

  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refresh) : null
  resize?.observe(content)
  if (content !== viewport) resize?.observe(viewport)
  document.addEventListener('scroll', schedule, { capture: true, passive: true })
  window.addEventListener('resize', refresh)
  scrollbar.addEventListener('scroll', syncScroll, { passive: true })
  refresh()
  return { refresh, dispose() {
    resize?.disconnect()
    window.removeEventListener('resize', refresh)
    document.removeEventListener('scroll', schedule, true)
    if (frame) cancelAnimationFrame(frame)
    header.remove()
    scrollbar.remove()
  } }
}
