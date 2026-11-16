function parseCsvRow(line) {
  const fields = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted && character === '"' && line[index + 1] === '"') {
      value += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      fields.push(value.trim())
      value = ''
    } else {
      value += character
    }
  }
  if (quoted) return null
  fields.push(value.trim())
  return fields
}

function escapeCsvField(value) {
  return `"${value.replaceAll('"', '""')}"`
}

function normalizeSankeyLabels(source, frontmatterLength) {
  const prefix = source.slice(0, frontmatterLength)
  const body = source.slice(frontmatterLength)
  const lines = body.split(/(?<=\n)/)
  const declarationIndex = lines.findIndex((line) => line.trim())
  if (declarationIndex < 0 || !/^\s*sankey(?:-beta)?\s*$/i.test(lines[declarationIndex].trim())) {
    return { source, labels: {} }
  }

  const aliases = new Map()
  const labels = {}
  const aliasFor = (label) => {
    if (!aliases.has(label)) {
      let index = aliases.size
      let alias = `GuguMermaidNode${index}`
      const usedAliases = new Set(aliases.values())
      while (aliases.has(alias) || usedAliases.has(alias)) {
        alias = `GuguMermaidNode${++index}`
      }
      aliases.set(label, alias)
      labels[alias] = label
    }
    return aliases.get(label)
  }

  for (let index = declarationIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const newline = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
    const content = newline ? line.slice(0, -newline.length) : line
    if (!content.trim()) continue
    const fields = parseCsvRow(content)
    if (
      !fields || fields.length !== 3 || !fields[0] || !fields[1] ||
      !Number.isFinite(Number(fields[2]))
    ) continue
    lines[index] = `${escapeCsvField(aliasFor(fields[0]))},${escapeCsvField(aliasFor(fields[1]))},${fields[2]}${newline}`
  }

  return { source: `${prefix}${lines.join('')}`, labels }
}

const TIMELINE_LABEL_MAX_WIDTH = 135
const FULL_WIDTH_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u

function wrapTimelineLabel(label) {
  if (!FULL_WIDTH_CHARACTER.test(label) || /<br\s*\/?>/i.test(label)) return label

  return label.split(/(\s+)/).map((token) => {
    if (!FULL_WIDTH_CHARACTER.test(token)) return token
    const lines = []
    let line = ''
    let width = 0
    for (const character of token) {
      const characterWidth = FULL_WIDTH_CHARACTER.test(character) ? 16 : 9
      if (line && width + characterWidth > TIMELINE_LABEL_MAX_WIDTH) {
        lines.push(line)
        line = ''
        width = 0
      }
      line += character
      width += characterWidth
    }
    if (line) lines.push(line)
    return lines.join('<br>')
  }).join('')
}

/** Mermaid 时间线按空格切词；中文连续标签不会换行，按节点可用宽度插入布局断点。 */
function normalizeTimelineLabels(lines, declarationIndex) {
  if (declarationIndex < 0 || !/^\s*timeline(?:-beta)?\b/i.test(lines[declarationIndex].trim())) {
    return false
  }

  let changed = false
  for (let index = declarationIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const newline = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
    const content = newline ? line.slice(0, -newline.length) : line
    let nextLine = content.replace(/^(\s*section\s+)(.*?)(\s*)$/i, (_match, prefix, label, suffix) => {
      const wrapped = wrapTimelineLabel(label)
      return wrapped === label ? content : `${prefix}${wrapped}${suffix}`
    })
    if (nextLine === content) {
      nextLine = content.replace(/^(\s*[^:\r\n]+:\s*)(.*?)(\s*)$/, (_match, prefix, label, suffix) => {
        const wrapped = wrapTimelineLabel(label)
        return wrapped === label ? content : `${prefix}${wrapped}${suffix}`
      })
    }
    if (nextLine !== content) {
      lines[index] = `${nextLine}${newline}`
      changed = true
    }
  }
  return changed
}

/** 将常见别名规范化，并把 Sankey 标签暂时转为解析器可读的 ASCII 标识。 */
export function prepareMermaidDiagramSource(source, { forRasterizer = false } = {}) {
  const frontmatter = source.match(/^\uFEFF?[ \t]*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  const prefixLength = frontmatter?.[0].length || 0
  let body = source.slice(prefixLength)
  let changed = false

  // svgdom 的 Mermaid 文本测量不会解析 flowchart 标签里的 HTML 换行，
  // 会把多行节点输出成空 text。IM 仅接受 SVG 的光栅器路径，把 <br> 转为 Mermaid
  // 自身支持的转义换行；浏览器渲染保持原始 HTML 标签语义。
  if (forRasterizer && /^\s*(?:flowchart|graph)\b/im.test(body)) {
    const normalized = body.replace(/<br\s*\/?>/gi, '\\n')
    if (normalized !== body) {
      body = normalized
      changed = true
    }
  }

  const normalizedLines = body.split(/(?<=\n)/)
  const declarationIndex = normalizedLines.findIndex((line) => line.trim())
  if (declarationIndex >= 0) {
    const declaration = normalizedLines[declarationIndex]
    const match = declaration.match(/^([ \t]*)(fishbone|sankey-beta)([ \t]*)(\r?\n)?$/i)
    if (match) {
      const canonicalName = match[2].toLowerCase() === 'fishbone' ? 'ishikawa-beta' : 'sankey'
      normalizedLines[declarationIndex] = `${match[1]}${canonicalName}${match[3]}${match[4] || ''}`
      changed = true
    }
  }

  const normalizedDeclaration = normalizedLines[declarationIndex]?.trim() || ''
  if (/^xychart(?:-beta)?\b/i.test(normalizedDeclaration)) {
    for (let index = declarationIndex + 1; index < normalizedLines.length; index += 1) {
      const line = normalizedLines[index]
      const match = line.match(/^(\s*title\s+)([^"\r\n].*?)(\r?\n)?$/i)
      if (!match) continue
      normalizedLines[index] = `${match[1]}${JSON.stringify(match[2].trim())}${match[3] || ''}`
      changed = true
    }
  }

  for (let index = 0; index < normalizedLines.length; index += 1) {
    const line = normalizedLines[index]
    const withKeywordSpacing = line.replace(/^([ \t]*)subgraph(?=\S)/i, '$1subgraph ')
    const withTitleSpacing = withKeywordSpacing.replace(
      /^(\s*subgraph[ \t]+)([^\s\[\]]+)(\[)/i,
      '$1$2 $3',
    )
    if (withTitleSpacing !== line) {
      normalizedLines[index] = withTitleSpacing
      changed = true
    }
  }

  if (normalizeTimelineLabels(normalizedLines, declarationIndex)) changed = true

  const normalizedSource = changed ? `${source.slice(0, prefixLength)}${normalizedLines.join('')}` : source
  return normalizeSankeyLabels(normalizedSource, prefixLength)
}

/** 恢复渲染后 Sankey 的原始标签；仅修改 SVG 文字，不解释或执行标签内容。 */
export function restoreMermaidDiagramLabels(root, labels = {}) {
  if (!labels || !Object.keys(labels).length) return
  for (const text of root.getElementsByTagName('text')) {
    const label = labels[text.textContent || '']
    if (label !== undefined) text.textContent = label
  }
}

/** 保留字符串接口供仅需规范化源码的调用方使用。 */
export function normalizeMermaidDiagramSource(source, options = {}) {
  return prepareMermaidDiagramSource(source, options).source
}
