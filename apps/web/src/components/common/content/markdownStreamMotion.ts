const duration = 190
const stagger = 16
const maxLead = 200
const maxGroups = 10
const words = new Intl.Segmenter(undefined, { granularity: 'word' })

type Reveal = { start: number; end: number; time: number }

function queueReveal(pending: Reveal[], text: string, start: number, now: number): void {
  const ends = Array.from(words.segment(text.slice(start)))
    .filter(({ segment }) => segment.trim())
    .map(({ index, segment }) => start + index + segment.length)
  if (!ends.length) return
  const groupSize = Math.ceil(ends.length / maxGroups)
  const groupCount = Math.ceil(ends.length / groupSize)
  const deadline = now + maxLead
  const previous = pending.at(-1)
  // SSE 批次共享同一条时间线。拥挤时压缩间隔，避免显示进度落后太久。
  const first = previous ? Math.min(deadline, Math.max(now, previous.time + stagger)) : now
  const step = Math.min(stagger, (deadline - first) / Math.max(1, groupCount - 1))
  for (let index = 0; index < groupCount; index++) {
    const end = ends[Math.min((index + 1) * groupSize, ends.length) - 1]
    const time = first + index * step
    const last = pending.at(-1)
    if (last?.time === time && last.end === start) last.end = end
    else pending.push({ start, end, time })
    start = end
  }
}

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
    pending = pending.filter(batch => now - batch.time < duration)
    if (text.length > start) queueReveal(pending, text, start, now)
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
        // 相对定位保留行内换行，位移只影响绘制。
        span.style.position = 'relative'
        span.animate(
          [{ opacity: 0, filter: 'blur(3px)', top: '2px' }, { opacity: 1, filter: 'blur(0)', top: '0px' }],
          { duration, delay: batch.time - now, easing: 'ease-out', fill: 'backwards' },
        )
      }
    }
  }
}
