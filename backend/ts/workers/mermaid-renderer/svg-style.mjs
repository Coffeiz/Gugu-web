function roundPolylineCorners(path) {
  const pointPattern = /([ML])\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)[,\s]+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi
  const segments = [...path.matchAll(pointPattern)]
  if (segments.length < 3 || path.replace(pointPattern, '').replace(/[\s,]+/g, '')) return null
  if (segments[0][1].toUpperCase() !== 'M' || segments.slice(1).some(segment => segment[1].toUpperCase() !== 'L')) return null

  const points = segments.map(segment => ({ x: Number(segment[2]), y: Number(segment[3]) }))
  const format = value => Number(value.toFixed(2)).toString()
  const point = ({ x, y }) => `${format(x)},${format(y)}`
  const commands = [`M${point(points[0])}`]

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const next = points[index + 1]
    const incomingX = previous.x - current.x
    const incomingY = previous.y - current.y
    const outgoingX = next.x - current.x
    const outgoingY = next.y - current.y
    const incomingLength = Math.hypot(incomingX, incomingY)
    const outgoingLength = Math.hypot(outgoingX, outgoingY)
    const cross = incomingX * outgoingY - incomingY * outgoingX
    const dot = incomingX * outgoingX + incomingY * outgoingY

    if (
      Math.abs(cross) < 0.001 || incomingLength < 1 || outgoingLength < 1
      || Math.abs(dot) > incomingLength * outgoingLength * 0.05
    ) {
      commands.push(`L${point(current)}`)
      continue
    }

    const radius = Math.min(12, incomingLength / 2, outgoingLength / 2)
    const before = {
      x: current.x + (incomingX / incomingLength) * radius,
      y: current.y + (incomingY / incomingLength) * radius,
    }
    const after = {
      x: current.x + (outgoingX / outgoingLength) * radius,
      y: current.y + (outgoingY / outgoingLength) * radius,
    }
    commands.push(`L${point(before)}Q${point(current)} ${point(after)}`)
  }

  commands.push(`L${point(points.at(-1))}`)
  return commands.join('')
}

function normalizeEdgePaths(root) {
  const edgeClass = /(?:^|\s)(?:flowchart-link|messageLine\S*|transition|relationshipLine|edgePath|link)(?:\s|$)/
  const edges = [...root.getElementsByTagName('path')].filter((edge) => {
    const className = edge.getAttribute('class') || ''
    return edgeClass.test(className) || edge.hasAttribute('marker-start') || edge.hasAttribute('marker-end')
  })
  for (const edge of edges) {
    edge.style.strokeLinecap = 'round'
    edge.style.strokeLinejoin = 'round'
    if (
      (edge.getAttribute('class') || '').split(/\s+/).includes('flowchart-link') ||
      edge.hasAttribute('marker-start') || edge.hasAttribute('marker-end')
    ) {
      const rounded = roundPolylineCorners(edge.getAttribute('d') || '')
      if (rounded) edge.setAttribute('d', rounded)
    }
  }
}

function normalizePointArrowMarkers(root, arrowheadColor) {
  for (const marker of root.getElementsByTagName('marker')) {
    const isEnd = marker.getAttribute('id')?.endsWith('-pointEnd')
    const isStart = marker.getAttribute('id')?.endsWith('-pointStart')
    if (!isEnd && !isStart) continue
    const arrow = [...marker.getElementsByTagName('path')].find(path =>
      (path.getAttribute('class') || '').split(/\s+/).includes('arrowMarkerPath'),
    )
    if (!arrow) continue
    marker.setAttribute('markerWidth', '9.5')
    marker.setAttribute('markerHeight', '9.5')
    marker.setAttribute('viewBox', '0 0 10 10')
    marker.setAttribute('refX', isEnd ? '4.65' : '5.35')
    marker.setAttribute('refY', '5')
    arrow.setAttribute(
      'd',
      isEnd
        ? 'M 0 0 L 4.2 4 C 4.8 4.57 4.8 5.43 4.2 6 L 0 10'
        : 'M 10 0 L 5.8 4 C 5.2 4.57 5.2 5.43 5.8 6 L 10 10',
    )
    arrow.setAttribute('fill', 'none')
    arrow.setAttribute('stroke', arrowheadColor)
    arrow.style.strokeWidth = '1px'
    arrow.style.strokeLinecap = 'round'
    arrow.style.strokeLinejoin = 'round'
  }
}

/** 对前端 SVG 与 IM PNG 使用同一套 Mermaid 边线规范，保留非 point 类型的语义箭头。 */
export function normalizeMermaidEdgeStyles(root, arrowheadColor) {
  normalizeEdgePaths(root)
  normalizePointArrowMarkers(root, arrowheadColor)
  return root
}
