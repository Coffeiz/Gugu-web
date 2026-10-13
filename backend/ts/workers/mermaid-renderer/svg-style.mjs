const EDGE_LABEL_RADIUS_PX = 8

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

function setStyle(element, property, value) {
  const declarations = new Map(
    (element.getAttribute('style') || '')
      .split(';')
      .map(declaration => declaration.trim())
      .filter(Boolean)
      .map(declaration => {
        const separator = declaration.indexOf(':')
        return separator < 0
          ? [declaration, '']
          : [declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim()]
      }),
  )
  declarations.set(property, value)
  element.setAttribute('style', [...declarations].map(([name, entry]) => `${name}: ${entry}`).join('; '))
}

function normalizeEdgePaths(root) {
  const edgeClass = /(?:^|\s)(?:flowchart-link|messageLine\S*|transition|relationshipLine|edgePath|link)(?:\s|$)/
  const edges = [...root.getElementsByTagName('path')].filter((edge) => {
    const className = edge.getAttribute('class') || ''
    return edgeClass.test(className) || edge.hasAttribute('marker-start') || edge.hasAttribute('marker-end')
  })
  for (const edge of edges) {
    setStyle(edge, 'stroke-linecap', 'round')
    setStyle(edge, 'stroke-linejoin', 'round')
    if (
      (edge.getAttribute('class') || '').split(/\s+/).includes('flowchart-link') ||
      edge.hasAttribute('marker-start') || edge.hasAttribute('marker-end')
    ) {
      const rounded = roundPolylineCorners(edge.getAttribute('d') || '')
      if (rounded) edge.setAttribute('d', rounded)
    }
  }
}

function keepSequenceSelfLoopArrowheadsOnLifeline(root) {
  const markersById = new Map([...root.getElementsByTagName('marker')].map(marker => [
    marker.getAttribute('id'),
    marker,
  ]))

  for (const edge of [...root.getElementsByTagName('path')]) {
    if (!/(?:^|\s)messageLine\S*(?:\s|$)/.test(edge.getAttribute('class') || '')) continue
    const coordinates = (edge.getAttribute('d') || '').match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)
    if (coordinates?.length !== 8 || Math.abs(Number(coordinates[0]) - Number(coordinates[6])) > 0.001) continue

    const markerReference = edge.getAttribute('marker-end')?.match(/^url\(#([^)]+)\)$/)
    const marker = markerReference ? markersById.get(markerReference[1]) : null
    if (!marker) continue

    // Resvg 会把 Mermaid 的 auto-start-reverse marker 错误反向应用到曲线末端，
    // 让箭头头部越过生命线。自调用箭头改用 auto，并把箭头尖端锚到曲线终点。
    const markerId = `${markerReference[1]}-self-loop`
    let selfLoopMarker = markersById.get(markerId)
    if (!selfLoopMarker) {
      selfLoopMarker = marker.cloneNode(true)
      selfLoopMarker.setAttribute('id', markerId)
      selfLoopMarker.setAttribute('orient', 'auto')
      selfLoopMarker.setAttribute('refX', '10')
      marker.parentNode.appendChild(selfLoopMarker)
      markersById.set(markerId, selfLoopMarker)
    }
    edge.setAttribute('marker-end', `url(#${markerId})`)
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
    setStyle(arrow, 'stroke-width', '1px')
    setStyle(arrow, 'stroke-linecap', 'round')
    setStyle(arrow, 'stroke-linejoin', 'round')
  }
}

/** 对前端 SVG 与 IM PNG 使用同一套 Mermaid 边线规范，保留非 point 类型的语义箭头。 */
export function normalizeMermaidEdgeStyles(root, arrowheadColor) {
  normalizeEdgePaths(root)
  keepSequenceSelfLoopArrowheadsOnLifeline(root)
  normalizePointArrowMarkers(root, arrowheadColor)
  return root
}

/** Resvg 对 Mermaid 内嵌 CSS 的 rx 支持不完整，直接把 Web 同款圆角写入 SVG 节点。 */
export function normalizeMermaidNodeCorners(root) {
  for (const node of root.getElementsByTagName('g')) {
    if (!(node.getAttribute('class') || '').split(/\s+/).includes('node')) continue
    for (const shape of node.getElementsByTagName('rect')) {
      shape.setAttribute('rx', '12')
      shape.setAttribute('ry', '12')
    }
  }
  return root
}

/** Mermaid 的 mindmap 根节点标签以 x=0 起绘制；居中锚定可避免文字偏到圆形节点右侧。 */
export function normalizeMermaidMindmapRootLabel(root) {
  if (root.getAttribute('aria-roledescription') !== 'mindmap') return root
  const rootNode = [...root.getElementsByTagName('g')].find((node) => {
    const classes = (node.getAttribute('class') || '').split(/\s+/)
    return classes.includes('mindmap-node') && (classes.includes('section-root') || classes.includes('root'))
  })
  rootNode?.getElementsByTagName('text')[0]?.setAttribute('text-anchor', 'middle')
  return root
}

/** Resvg 的 SVG 文本测量会让 Mermaid kanban 列标题偏右；按列边界重新居中。 */
export function normalizeMermaidKanbanSectionTitles(root) {
  for (const cluster of root.getElementsByTagName('g')) {
    const classes = (cluster.getAttribute('class') || '').split(/\s+/)
    if (!classes.includes('cluster') || !classes.some(name => /^section-\d+$/.test(name))) continue

    const bounds = cluster.getElementsByTagName('rect')[0]
    const labelGroup = [...cluster.getElementsByTagName('g')].find(group =>
      (group.getAttribute('class') || '').split(/\s+/).includes('cluster-label'),
    )
    const text = labelGroup?.getElementsByTagName('text')[0]
    const transform = labelGroup?.getAttribute('transform') || ''
    const position = transform.match(/^translate\(\s*([-+\d.eE]+)[, ]+\s*([-+\d.eE]+)\s*\)$/)
    const x = Number.parseFloat(bounds?.getAttribute('x') || '')
    const width = Number.parseFloat(bounds?.getAttribute('width') || '')
    if (!text || !position || !Number.isFinite(x) || !Number.isFinite(width)) continue

    text.setAttribute('text-anchor', 'middle')
    labelGroup.setAttribute('transform', `translate(${x + width / 2}, ${position[2]})`)
  }
  return root
}

/** svgdom 的 CJK 文字宽度偏小，会让连线标签底色变窄并露出穿过文字的连线。 */
export function normalizeMermaidEdgeLabelBounds(root) {
  const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
  for (const group of root.getElementsByTagName('g')) {
    if (!(group.getAttribute('class') || '').split(/\s+/).includes('edgeLabel')) continue
    const text = group.getElementsByTagName('text')[0]
    for (const rect of group.getElementsByTagName('rect')) {
      const rectClass = rect.getAttribute('class') || ''
      if (!/(?:^|\s)(?:background|labelBkg)(?:\s|$)/.test(rectClass)) continue
      rect.setAttribute('rx', String(EDGE_LABEL_RADIUS_PX))
      rect.setAttribute('ry', String(EDGE_LABEL_RADIUS_PX))
    }
    if (!text) continue
    const tspans = [...text.getElementsByTagName('tspan')]
    const lines = tspans.length ? tspans.map(tspan => tspan.textContent || '') : [text.textContent || '']
    if (!lines.some(line => [...line].some(character => cjkCharacter.test(character)))) continue

    const fontSizeValue = text.getAttribute('font-size') || text.getAttribute('style')?.match(/font-size\s*:\s*([\d.]+)px?/)?.[1]
    const fontSize = Number.parseFloat(fontSizeValue || '') || 16
    const textWidth = Math.max(...lines.map(line => [...line].reduce(
      (width, character) => width + fontSize * (cjkCharacter.test(character) ? 1 : character.trim() ? 0.6 : 0.33),
      0,
    )))
    const minimumWidth = textWidth + 4

    for (const rect of group.getElementsByTagName('rect')) {
      const rectClass = rect.getAttribute('class') || ''
      if (!/(?:^|\s)(?:background|labelBkg)(?:\s|$)/.test(rectClass)) continue
      const width = Number.parseFloat(rect.getAttribute('width') || '')
      if (!Number.isFinite(width) || width >= minimumWidth) continue
      const x = Number.parseFloat(rect.getAttribute('x') || '0')
      rect.setAttribute('x', String(x - (minimumWidth - width) / 2))
      rect.setAttribute('width', String(minimumWidth))
    }
  }
  return root
}

/** Resvg 会把 svgdom 生成的 CJK 连线文字基线绘制在底色框下方；显式校正文字基线和字重。 */
export function normalizeMermaidRasterText(root, textColor, options = {}) {
  if (options.colorAllText) {
    for (const text of root.getElementsByTagName('text')) {
      // Journey 的 SVG 文本路径会在 task/section 标签上直接写 fill="#fff"；
      // Resvg 不会像 Web 的 foreignObject 文本那样继承页面文字色，需要显式跟随当前主题。
      setStyle(text, 'fill', textColor)
    }
  }

  if (options.allText) {
    for (const text of root.getElementsByTagName('text')) {
      const textParts = [text, ...text.getElementsByTagName('tspan')]
      for (const textPart of textParts) {
        setStyle(textPart, 'font-family', options.fontFamily || 'Noto Sans SC')
        setStyle(textPart, 'font-weight', options.fontWeight || '600')
        if (options.colorAllText) setStyle(textPart, 'fill', textColor)
        if (options.strokeAllText) {
          setStyle(textPart, 'stroke', textColor)
          setStyle(textPart, 'stroke-width', '0.4px')
          setStyle(textPart, 'paint-order', 'stroke')
        }
      }
    }
  }

  for (const text of root.getElementsByTagName('tspan')) {
    if (!(text.getAttribute('class') || '').split(/\s+/).includes('text-inner-tspan')) continue
    // Resvg 对 Noto Sans SC 可变字重的匹配比浏览器偏细，用显式字重和轻微描边
    // 逼近 Web 的 500 字重，同时避免按字号加粗造成中文笔画糊成一片。
    setStyle(text, 'font-weight', '600')
    setStyle(text, 'fill', textColor)
    setStyle(text, 'stroke', textColor)
    setStyle(text, 'stroke-width', '0.4px')
    setStyle(text, 'paint-order', 'stroke')
  }

  const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
  for (const group of root.getElementsByTagName('g')) {
    const classes = (group.getAttribute('class') || '').split(/\s+/)
    if (!classes.includes('edgeLabel') && !classes.includes('edgeTerminals')) continue
    const text = group.getElementsByTagName('text')[0]
    const content = text?.textContent || ''
    if (!text) continue
    const hasCjk = [...content].some(character => cjkCharacter.test(character))
    const hasRasterizerBaselineOffset = [...text.getElementsByTagName('tspan')].some(tspan =>
      tspan.getAttribute('y') === '-0.1em' && tspan.getAttribute('dy') === '1.1em',
    )
    if (!hasCjk && !hasRasterizerBaselineOffset) continue
    const fontSizeValue = text.getAttribute('font-size') || text.getAttribute('style')?.match(/font-size\s*:\s*([\d.]+)px?/)?.[1]
    const fontSize = Number.parseFloat(fontSizeValue || '') || 16
    const existing = text.getAttribute('transform')
    const baselineCorrection = `translate(0 ${(-fontSize * 0.9).toFixed(2)})`
    text.setAttribute('transform', existing ? `${baselineCorrection} ${existing}` : baselineCorrection)
  }
  return root
}
