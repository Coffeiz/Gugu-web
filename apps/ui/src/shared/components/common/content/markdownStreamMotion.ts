export const markdownStreamMotionDuration = 150

export function animateStreamFade(element: Element, delay = 0) {
  element.animate?.(
    [{ opacity: 0.25, filter: 'blur(2px)' }, { opacity: 1, filter: 'blur(0)' }],
    { duration: markdownStreamMotionDuration, delay, easing: 'ease-out', fill: 'backwards' },
  )
}

type Reveal = { start: number; end: number; time: number }

export function createMarkdownStreamMotion() {
  let previousText = ''
  let pending: Reveal[] = []

  return (root: HTMLElement, animate: boolean): void => {
    const text = (root.textContent ?? '').trimEnd()
    const start = previousText.length
    const appended = text.startsWith(previousText)
    previousText = text

    if (!animate || !appended || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pending = []
      return
    }

    const now = performance.now()
    pending = pending.filter(batch => now - batch.time < markdownStreamMotionDuration)
    if (text.length > start) pending.push({ start, end: text.length, time: now })
    if (!pending.length) return

    // Markdown 每次更新都会重建 DOM。按文字偏移恢复仍在播放的批次及其进度。
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes: { node: Text; start: number; end: number }[] = []
    let offset = 0
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const end = offset + node.length
      if (end > pending[0].start && node.length) nodes.push({ node, start: offset, end })
      offset = end
    }

    for (const entry of nodes) {
      for (let index = pending.length - 1; index >= 0; index--) {
        const batch = pending[index]
        const from = Math.max(entry.start, batch.start) - entry.start
        const to = Math.min(entry.end, batch.end) - entry.start
        if (from >= to || !entry.node.data.slice(from, to).trim()) continue
        const range = document.createRange()
        range.setStart(entry.node, from)
        range.setEnd(entry.node, to)
        const span = document.createElement('span')
        range.surroundContents(span)
        animateStreamFade(span, batch.time - now)
      }
    }
  }
}
