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

function normalizeRasterColor(color) {
  const hsl = color.match(/^hsl\(\s*(-?[\d.]+)[, ]+([\d.]+)%[, ]+([\d.]+)%\s*\)$/i)
  if (!hsl) return color
  const hue = ((Number(hsl[1]) % 360) + 360) % 360
  const saturation = Number(hsl[2]) / 100
  const lightness = Number(hsl[3]) / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1))
  const offset = lightness - chroma / 2
  const channelsBySector = [
    [chroma, x, 0], [x, chroma, 0], [0, chroma, x],
    [0, x, chroma], [x, 0, chroma], [chroma, 0, x],
  ]
  const channels = channelsBySector[Math.floor(hue / 60)]
  return `rgb(${channels.map(channel => Math.round((channel + offset) * 255)).join(', ')})`
}

/** Resvg 对部分 Mermaid 生成的 HSL 色值会回退成黑色；统一转换 SVG 中的色值。 */
export function normalizeMermaidRasterColors(root) {
  const hslColor = /hsl\(\s*-?[\d.]+(?:deg)?[, ]+\s*[\d.]+%[, ]+\s*[\d.]+%\s*\)/gi
  const normalize = value => value.replace(hslColor, color => normalizeRasterColor(color))
  for (const element of root.getElementsByTagName('*')) {
    for (const attribute of [...element.attributes]) {
      const value = normalize(attribute.value)
      if (value !== attribute.value) element.setAttribute(attribute.name, value)
    }
  }
  for (const style of root.getElementsByTagName('style')) {
    const css = style.textContent || ''
    const nextCss = normalize(css)
    if (nextCss !== css) style.textContent = nextCss
  }
  return root
}

function styleDeclarations(element) {
  return new Map((element.getAttribute('style') || '').split(';').flatMap((entry) => {
    const separator = entry.indexOf(':')
    return separator < 0 ? [] : [[entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]]
  }))
}

/** 按 State Diagram 节点矩形中心设置标签锚点，覆盖 Mermaid 默认左对齐的行坐标。 */
export function normalizeMermaidStateDiagramLabelAlignment(root) {
  for (const node of root.getElementsByTagName('g')) {
    if (!(node.getAttribute('class') || '').split(/\s+/).includes('statediagram-state')) continue
    const box = [...node.getElementsByTagName('rect')].find(rect =>
      (rect.getAttribute('class') || '').split(/\s+/).includes('basic'),
    )
    const boxX = Number.parseFloat(box?.getAttribute('x') || '')
    const boxY = Number.parseFloat(box?.getAttribute('y') || '')
    const boxWidth = Number.parseFloat(box?.getAttribute('width') || '')
    const boxHeight = Number.parseFloat(box?.getAttribute('height') || '')
    if (![boxX, boxY, boxWidth, boxHeight].every(Number.isFinite)) continue
    const centerX = boxX + boxWidth / 2
    const centerY = boxY + boxHeight / 2

    for (const label of node.getElementsByTagName('g')) {
      if (!(label.getAttribute('class') || '').split(/\s+/).includes('label')) continue
      const translate = label.getAttribute('transform')?.match(/translate\(\s*(-?[\d.]+)(?:[ ,]+(-?[\d.]+))?\s*\)/)
      const labelOffsetX = Number.parseFloat(translate?.[1] || '0')
      const labelOffsetY = Number.parseFloat(translate?.[2] || '0')
      const textX = String(centerX - labelOffsetX)
      const textY = String(centerY - labelOffsetY)
      for (const text of label.getElementsByTagName('text')) {
        setStyle(text, 'text-anchor', 'middle')
        setStyle(text, 'dominant-baseline', 'central')
        text.setAttribute('x', textX)
        text.setAttribute('y', textY)

        const spans = [...text.getElementsByTagName('tspan')]
        const rows = spans.filter(line => (line.getAttribute('class') || '').split(/\s+/).includes('row'))
        for (const [index, row] of rows.entries()) {
          row.setAttribute('x', textX)
          row.removeAttribute('y')
          row.setAttribute('dy', index === 0 ? `${-0.55 * (rows.length - 1)}em` : '1.1em')
        }
      }
    }
  }
  return root
}

function matchesSimpleSelector(element, selector) {
  if (!element || element.nodeType !== 1) return false
  const simple = selector.replace(/:[\w-]+(?:\([^)]*\))?/g, '').trim()
  const tag = simple.match(/^[a-z][\w-]*/i)?.[0]
  if (tag && element.localName.toLowerCase() !== tag.toLowerCase()) return false
  const classes = new Set((element.getAttribute('class') || '').split(/\s+/).filter(Boolean))
  return [...simple.matchAll(/\.([\w-]+)/g)].every((match) => classes.has(match[1]))
}

function matchingCssFill(element, root) {
  let resolved = ''
  let bestSpecificity = -1
  let bestOrder = -1
  let order = 0
  for (const style of root.getElementsByTagName('style')) {
    for (const rule of (style.textContent || '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const fill = rule[2].match(/(?:^|;)\s*fill\s*:\s*([^;!]+)(?:;|$)/i)?.[1]?.trim()
      if (!fill) continue
      for (const selector of rule[1].split(',')) {
        const parts = selector.trim().replace(/>/g, ' ').split(/\s+/).filter(Boolean)
        let candidate = element
        let matches = true
        for (let index = parts.length - 1; index >= 0; index -= 1) {
          while (candidate && !matchesSimpleSelector(candidate, parts[index])) candidate = candidate.parentNode
          if (!candidate || candidate.nodeType !== 1) {
            matches = false
            break
          }
          candidate = candidate.parentNode
        }
        if (!matches) continue
        const specificity = (selector.match(/[.#\[]/g) || []).length
        if (specificity > bestSpecificity || (specificity === bestSpecificity && order >= bestOrder)) {
          resolved = fill
          bestSpecificity = specificity
          bestOrder = order
        }
      }
      order += 1
    }
  }
  return resolved
}

function svgColor(color) {
  const normalized = normalizeRasterColor(color.trim())
  const hex = normalized.match(/^#([\da-f]{6})$/i)
  if (hex) return [0, 2, 4].map(index => Number.parseInt(hex[1].slice(index, index + 2), 16))
  const rgb = normalized.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i)
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) < 0.99)) return null
  return rgb.slice(1, 4).map(Number)
}

function svgContrast(first, second) {
  const luminance = channels => channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

/** 为自定义深色节点和实体表格修正低对比文字，保留本身已可读的自定义颜色。 */
export function normalizeMermaidRasterTextContrast(root, defaultTextColor) {
  const black = [0, 0, 0]
  const white = [255, 255, 255]
  const textElements = [...root.getElementsByTagName('text'), ...root.getElementsByTagName('tspan')]
  for (const text of textElements) {
    let container = text.parentNode
    let background = null
    while (container && container !== root) {
      if (container.nodeType === 1 && container.localName === 'g') {
        const shapes = ['rect', 'polygon', 'ellipse', 'circle', 'path']
          .flatMap(name => [...container.getElementsByTagName(name)])
        const shape = shapes.find(item => item !== text && item.getAttribute('fill') !== 'none')
        if (shape) {
          const fill = styleDeclarations(shape).get('fill') || matchingCssFill(shape, root) || shape.getAttribute('fill')
          background = fill ? svgColor(fill) : null
          if (background) break
        }
      }
      container = container.parentNode
    }
    if (!background) continue

    const declarations = styleDeclarations(text)
    const foregroundValue = declarations.get('fill') || matchingCssFill(text, root) || text.getAttribute('fill') || defaultTextColor
    const foreground = svgColor(foregroundValue)
    if (!foreground || svgContrast(background, foreground) >= 4.5) continue
    const readable = svgContrast(background, white) >= svgContrast(background, black) ? '#ffffff' : '#000000'
    setStyle(text, 'fill', readable)
    setStyle(text, 'stroke', readable)
  }
  return root
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

/** Resvg 漏掉首列的 Mermaid section 样式；把列底色内联，保持图片与浏览器 SVG 一致。 */
export function normalizeMermaidKanbanSectionColors(root) {
  const styles = [...root.getElementsByTagName('style')]
  for (const cluster of root.getElementsByTagName('g')) {
    const section = (cluster.getAttribute('class') || '').split(/\s+/).find(name => /^section-\d+$/.test(name))
    if (!section) continue
    const pattern = new RegExp(`\\.${section}\\s+rect[^{}]*\\{[^}]*\\bfill:\\s*([^;}]+)`, 'gi')
    let fill
    for (const style of styles) {
      for (const match of (style.textContent || '').matchAll(pattern)) fill = match[1].trim()
    }
    if (!fill) continue
    fill = normalizeRasterColor(fill)
    const rect = cluster.getElementsByTagName('rect')[0]
    if (rect) {
      setStyle(rect, 'fill', fill)
      setStyle(rect, 'stroke', fill)
    }
  }
  return root
}

/** Resvg 未能稳定解析 Mermaid 时间线的 HSL 色阶，内联转换后的色值避免整段变黑。 */
export function normalizeMermaidTimelineSectionColors(root) {
  const styles = [...root.getElementsByTagName('style')]
  const fills = new Map()
  for (const style of styles) {
    const css = style.textContent || ''
    for (const match of css.matchAll(/\.section-(-?\d+)\s+(?:rect|path|circle)[^{]*\{([^}]*)\}/gi)) {
      const fill = match[2].match(/\bfill\s*:\s*([^;}]+)/i)?.[1]?.trim()
      if (fill) fills.set(`section-${match[1]}`, normalizeRasterColor(fill))
    }
  }

  for (const group of root.getElementsByTagName('g')) {
    const classes = (group.getAttribute('class') || '').split(/\s+/)
    if (!classes.includes('timeline-node')) continue
    const section = classes.find(name => /^section--?\d+$/.test(name))
    const fill = section ? fills.get(section) : undefined
    if (!fill) continue
    for (const shapeName of ['rect', 'path', 'circle']) {
      for (const shape of group.getElementsByTagName(shapeName)) setStyle(shape, 'fill', fill)
    }
  }
  return root
}

/** svgdom 会把数据库节点标签的 SVG 组左移半个标签宽度；栅格化前移回圆柱中心。 */
export function normalizeMermaidDatabaseLabelPosition(root) {
  for (const node of root.getElementsByTagName('g')) {
    if (!(node.getAttribute('class') || '').split(/\s+/).includes('node')) continue
    const databaseShape = [...node.getElementsByTagName('path')].some(path =>
      (path.getAttribute('class') || '').split(/\s+/).includes('outer-path'),
    )
    if (!databaseShape) continue
    for (const label of node.getElementsByTagName('g')) {
      if (!(label.getAttribute('class') || '').split(/\s+/).includes('label')) continue
      const transform = label.getAttribute('transform') || ''
      const translated = transform.match(/^translate\(\s*([-+\d.eE]+)[, ]+\s*([-+\d.eE]+)\s*\)$/)
      if (translated) label.setAttribute('transform', `translate(0, ${translated[2]})`)
      for (const text of label.getElementsByTagName('text')) {
        text.setAttribute('text-anchor', 'middle')
      }
    }
  }
  return root
}

/** svgdom 的文字宽度可能偏小，会让连线标签底色变窄并露出穿过文字的连线。 */
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
      if (!Number.isFinite(width)) continue

      // Mermaid's SVG puts centered edge text at its anchor (usually x=0), but
      // svgdom can return a text box whose left edge is asymmetric. Expanding
      // the original rect around its own center preserves that error and makes
      // the label look shifted beside the text. Center the rect on the actual
      // middle text anchor before applying the CJK width correction.
      const anchorXs = tspans
        .map(tspan => Number.parseFloat(tspan.getAttribute('x') || ''))
        .filter(Number.isFinite)
      const textX = Number.parseFloat(text.getAttribute('x') || '')
      const anchorX = Number.isFinite(textX) ? textX : anchorXs[0] ?? 0
      const nextWidth = Math.max(width, minimumWidth)
      if (text.getAttribute('text-anchor') === 'middle') {
        rect.setAttribute('x', String(anchorX - nextWidth / 2))
      } else if (width < minimumWidth) {
        const x = Number.parseFloat(rect.getAttribute('x') || '0')
        rect.setAttribute('x', String(x - (minimumWidth - width) / 2))
      }
      if (width < minimumWidth) rect.setAttribute('width', String(minimumWidth))
    }
  }
  return root
}

/** Resvg 会把 svgdom 生成的 CJK 连线文字基线绘制在底色框下方；显式校正文字基线和字重。 */
export function normalizeMermaidRasterText(root, textColor, options = {}) {
  normalizeMermaidDatabaseLabelPosition(root)

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
          setStyle(textPart, 'stroke-width', options.strokeWidth || '0.4px')
          setStyle(textPart, 'paint-order', 'stroke')
        }
      }
      const classes = (text.getAttribute('class') || '').split(/\s+/)
      if (classes.includes('ishikawa-head-label')) {
        setStyle(text, 'dominant-baseline', 'central')
        // 鱼头路径以本地图形坐标 y=0 为垂直中心；保留 Mermaid 的水平定位，
        // 将文本组的垂直锚点对齐到鱼头中心，再由 central 基线居中每一行。
        const transform = text.getAttribute('transform') || ''
        const translated = transform.match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/)
        if (translated) {
          text.setAttribute('transform', transform.replace(translated[0], `translate(${translated[1]} 0)`))
        }
      } else if (classes.includes('ishikawa-label')) {
        const baseline = classes.includes('cause')
          ? 'central'
          : classes.includes('up') ? 'baseline' : classes.includes('down') ? 'hanging' : 'middle'
        setStyle(text, 'dominant-baseline', baseline)
        if (classes.includes('cause')) {
          const box = [...text.parentNode.getElementsByTagName('rect')].find(rect =>
            (rect.getAttribute('class') || '').split(/\s+/).includes('ishikawa-label-box'),
          )
          const y = Number.parseFloat(box?.getAttribute('y') || '')
          const height = Number.parseFloat(box?.getAttribute('height') || '')
          if (Number.isFinite(y) && Number.isFinite(height)) {
            text.setAttribute('y', String(y + height / 2))
          }
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
