const duration = 200

export function createMarkdownStreamMotion() {
  let previousText = ''
  let batches: { start: number; end: number; time: number }[] = []

  return (root: HTMLElement, animate: boolean): void => {
    const text = (root.textContent ?? '').trimEnd()
    const start = previousText.length
    const appended = text.startsWith(previousText)
    previousText = text

    if (!animate || !appended || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      batches = []
      return
    }

    const now = performance.now()
    batches = batches.filter(batch => now - batch.time < duration)
    if (text.length > start) batches.push({ start, end: text.length, time: now })
    if (!batches.length) return

    // Markdown 每次更新都会重建 DOM。按文字偏移恢复仍在播放的批次及其进度。
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes: { node: Text; start: number; end: number }[] = []
    let offset = 0
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const end = offset + node.length
      if (end > batches[0].start && node.length) nodes.push({ node, start: offset, end })
      offset = end
    }

    for (const entry of nodes) {
      for (let index = batches.length - 1; index >= 0; index--) {
        const batch = batches[index]
        const from = Math.max(entry.start, batch.start) - entry.start
        const to = Math.min(entry.end, batch.end) - entry.start
        if (from >= to || !entry.node.data.slice(from, to).trim()) continue
        const range = document.createRange()
        range.setStart(entry.node, from)
        range.setEnd(entry.node, to)
        const span = document.createElement('span')
        range.surroundContents(span)
        // 相对定位保留行内换行，位移只影响绘制。
        span.style.position = 'relative'
        span.animate(
          [{ opacity: 0.2, filter: 'blur(3px)', top: '2px' }, { opacity: 1, filter: 'blur(0)', top: '0px' }],
          { duration, delay: batch.time - now, easing: 'ease-out' },
        )
      }
    }
  }
}
