import {
  bindChartControls,
  createChartControl,
  createChartControlIcon,
  createChartControls,
} from './controls'

type MathRenderer = (
  element: HTMLElement,
  options: {
    delimiters: Array<{ left: string; right: string; display: boolean }>
    ignoredTags: string[]
    trust: boolean
    throwOnError: boolean
    maxExpand: number
    maxSize: number
  },
) => void

export type MarkdownMathLabels = {
  copy: string
  copied: string
  downloadPng: string
  showSource: string
  showRendered: string
  renderFailed: string
}

let renderMathInElement: MathRenderer | null = null
let mathAssetsPromise: Promise<void> | null = null

/** 防止 Markdown 转义规则吞掉 TeX 的 \(...\) / \[...\] 定界符，代码区域保持原样。 */
export function normalizeMarkdownMathSource(source: string) {
  let fence: { marker: string; size: number } | null = null
  let mathDelimiter: '$' | '$$' | null = null
  let normalized = ''
  source.split(/(?<=\n)/).forEach(line => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = { marker: marker[0], size: marker.length }
      else if (
        marker[0] === fence.marker
        && marker.length >= fence.size
        && !line.slice(fenceMatch[0].length).trim()
      ) fence = null
      normalized += line
      return
    }
    if (fence) {
      normalized += line
      return
    }

    // 逐段跳过行内代码，避免改动示例代码中的反斜杠和美元符号。
    const parts = line.split(/(`+[^`\n]*`+)/g)
    const displayMathContinues = mathDelimiter === '$$'
    const processed = parts.map((part, index) => {
      if (index % 2 === 1) return part
      const text = part
        .replace(/\\\[/g, () => '$$')
        .replace(/\\\]/g, () => '$$')
        .replace(/\\\(/g, () => '$')
        .replace(/\\\)/g, () => '$')
      let result = ''
      for (let cursor = 0; cursor < text.length;) {
        if (text[cursor] === '$') {
          let slashCount = 0
          for (let back = cursor - 1; back >= 0 && text[back] === '\\'; back--) slashCount++
          const delimiter = text[cursor + 1] === '$' ? '$$' : '$'
          if (slashCount % 2 === 0) {
            if (mathDelimiter === delimiter) mathDelimiter = null
            else if (!mathDelimiter) mathDelimiter = delimiter
            result += delimiter
            cursor += delimiter.length
            continue
          }
        }
        const character = text[cursor]
        // marked 会把数学下标中的下划线解析为斜体边界，生成 KaTeX 无法跨越的
        // <em> 节点。用 HTML 实体保留文本值，浏览器建成文本节点时仍还原为下划线。
        result += mathDelimiter && character === '_' ? '&#95;' : character
        cursor++
      }
      return result
    }).join('')

    // marked 会把多行文本拆成含 <br> 的多个文本节点，KaTeX 无法跨节点匹配块公式。
    // 将公式内部的换行折成空格；TeX 显式换行符（\\）仍会保留。
    if (displayMathContinues && normalized) normalized = normalized.replace(/\r?\n$/, '') + ' ' + processed
    else normalized += processed
    if (mathDelimiter === '$') mathDelimiter = null
  })
  return normalized
}

/** LaTeX 代码围栏既可写纯公式，也可自行用 Markdown 数学定界符分组。 */
export function prepareLatexCodeForMath(source: string): string {
  const hasDelimiters = /(?:\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\]|\$[^$\n]+\$)/.test(source)
  if (!hasDelimiters) return `$$\n${source}\n$$`

  let inEnvironment = false
  let openDelimiter: string | null = null
  return source.split('\n').map(line => {
    const startsEnvironment = /\\begin\s*\{/.test(line)
    const endsEnvironment = /\\end\s*\{/.test(line)
    if (startsEnvironment) inEnvironment = true
    const wasInsideMath = openDelimiter !== null
    const delimiters = [...line.matchAll(/\$\$|\\\[|\\\]|\\\(|\\\)|\$/g)].map(match => match[0])
    const hasDelimiter = delimiters.length > 0
    const isFormulaLine = /(?:\\[A-Za-z]+|[_^])/.test(line.trim())
    const rendered = !inEnvironment && !wasInsideMath && !hasDelimiter && isFormulaLine
      ? `$$${line}$$`
      : line
    delimiters.forEach(delimiter => {
      const isOpening = delimiter === '$' || delimiter === '$$' || delimiter === '\\[' || delimiter === '\\('
      if (isOpening) openDelimiter = delimiter
      else if ((delimiter === '\\]' && openDelimiter === '\\[')
        || (delimiter === '\\)' && openDelimiter === '\\(')) openDelimiter = null
      else if (delimiter === '$' && openDelimiter === '$') openDelimiter = null
      else if (delimiter === '$$' && openDelimiter === '$$') openDelimiter = null
    })
    if (endsEnvironment) inEnvironment = false
    return rendered
  }).join('\n')
}

function normalizeLegacyDisplayMath(root: HTMLElement) {
  // 部分已有文档用独立的 `[ TeX ]` 行表示块公式。只处理纯文本段落且包含明显 TeX
  // 语法的行，避免把普通方括号说明或 Markdown 链接当成公式。
  root.querySelectorAll<HTMLElement>('p').forEach(paragraph => {
    if ([...paragraph.childNodes].some(node => node.nodeType !== Node.TEXT_NODE)) return
    const text = paragraph.textContent?.trim() || ''
    if (text.length > 10_000) return
    const match = /^\[\s*([\s\S]+?)\s*\]$/.exec(text)
    if (!match || !/(?:\\[A-Za-z]+|[_^])/.test(match[1])) return
    paragraph.textContent = `\\[${match[1]}\\]`
  })
}

function hasMathCandidate(root: HTMLElement) {
  const legacyBlock = [...root.querySelectorAll<HTMLElement>('p')].some(paragraph => {
    if ([...paragraph.childNodes].some(node => node.nodeType !== Node.TEXT_NODE)) return false
    const text = paragraph.textContent?.trim() || ''
    return text.length <= 10_000 && /^\[\s*[\s\S]+?\s*\]$/.test(text)
      && /(?:\\[A-Za-z]+|[_^])/.test(text)
  })
  if (legacyBlock) return true

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return (node.parentElement?.closest('pre, code, script, style, textarea, option'))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })
  const delimiter = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\[[\s\S]+?\\\]|\\\([^\n]+?\\\)/
  while (walker.nextNode()) {
    if (delimiter.test(walker.currentNode.textContent || '')) return true
  }
  return false
}

async function ensureMathAssets() {
  if (!mathAssetsPromise) {
    mathAssetsPromise = Promise.all([
      import('katex/contrib/auto-render'),
      import('katex/dist/katex.min.css'),
    ]).then(([renderer]) => {
      renderMathInElement = renderer.default as MathRenderer
    }).catch(error => {
      mathAssetsPromise = null
      throw error
    })
  }
  await mathAssetsPromise
}

/** 只在挂载完成、HTML 已经消毒后调用；公式通过 KaTeX 的不信任输入模式排版。 */
export async function renderMarkdownMath(root: HTMLElement | null, labels: MarkdownMathLabels) {
  if (!root?.isConnected) return
  if (!hasMathCandidate(root)) return
  await ensureMathAssets()
  if (!root.isConnected || !renderMathInElement) return

  normalizeLegacyDisplayMath(root)
  renderMathInElement(root, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '$', right: '$', display: false },
    ],
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
    trust: false,
    throwOnError: false,
    maxExpand: 500,
    maxSize: 20,
  })

  root.querySelectorAll<HTMLElement>('.md-math-block').forEach(block => {
    if (block.classList.contains('md-math-error') || !block.querySelector('.md-math-result .katex-error')) return
    block.classList.add('md-math-error')
    const rendered = block.querySelector<HTMLElement>('.md-math-result')
    const source = block.querySelector<HTMLElement>('.md-math-source-view')
    const sourceText = source?.querySelector('code')?.textContent ?? source?.textContent ?? ''
    if (rendered) rendered.hidden = true
    if (source) source.hidden = true
    const error = document.createElement('div')
    error.className = 'md-mermaid-error md-math-error-source'
    error.textContent = `${labels.renderFailed}\n\n${sourceText}`
    block.append(error)
  })

  const mathNodes = [...root.querySelectorAll<HTMLElement>('.katex-display, .katex')]
    .filter(node => (!node.classList.contains('katex') || !node.closest('.katex-display'))
      && !node.closest('.md-math-error'))
  mathNodes.forEach(node => {
    if (node.parentElement?.classList.contains('md-math-copy-wrap')) return
    const source = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent
    if (!source) return
    const mathBlock = node.closest<HTMLElement>('.md-math-result')?.closest<HTMLElement>('.md-math-block')
    const wrapper = document.createElement('span')
    wrapper.className = 'md-math-copy-wrap'
    if (node.classList.contains('katex-display')) wrapper.classList.add('is-display')
    node.replaceWith(wrapper)
    wrapper.append(node)
    if (mathBlock) return
    const button = createChartControl({
      action: 'copy-source',
      label: labels.copy,
      content: createChartControlIcon('M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z'),
      className: 'md-math-copy-btn',
      data: { mathSource: source, copyLabel: labels.copy, copiedLabel: labels.copied },
    })
    const downloadButton = createChartControl({
      action: 'download-png',
      label: labels.downloadPng,
      content: createChartControlIcon('M12 3v12m-5-5 5 5 5-5M5 17v3h14v-3'),
      className: 'md-math-download-btn',
      data: { mathAction: 'download-png' },
    })
    const controls = createChartControls(['md-chart-controls--math'], [button, downloadButton])
    wrapper.append(controls)
  })

  root.querySelectorAll<HTMLElement>('.md-math-block').forEach(block => {
    if (block.classList.contains('md-math-error')) return
    let controls = block.querySelector<HTMLElement>(':scope > .md-chart-controls--math')
    if (!controls) {
      controls = createChartControls(['md-chart-controls--math'], [])
    }
    const source = block.querySelector('.md-math-source-view code')?.textContent ?? ''
    if (!controls.querySelector('.md-math-copy-btn')) {
      controls.append(createChartControl({
        action: 'copy-source',
        label: labels.copy,
        content: createChartControlIcon('M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z'),
        className: 'md-math-copy-btn',
        data: { mathSource: source, copyLabel: labels.copy, copiedLabel: labels.copied },
      }))
    }
    if (!controls.querySelector('[data-math-action="download-png"]')) {
      controls.append(createChartControl({
        action: 'download-png',
        label: labels.downloadPng,
        content: createChartControlIcon('M12 3v12m-5-5 5 5 5-5M5 17v3h14v-3'),
        className: 'md-math-download-btn',
        data: { mathAction: 'download-png' },
      }))
    }
    bindChartControls(controls)
    if (!controls.isConnected) block.append(controls)
    if (controls.querySelector('[data-math-action="toggle-source"]')) return
    const sourceButton = createChartControl({
      action: 'toggle-source',
      label: labels.showSource,
      text: '</>',
      className: 'md-math-source-toggle-btn',
      data: { mathAction: 'toggle-source' },
    })
    sourceButton.dataset.showSourceLabel = labels.showSource
    sourceButton.dataset.showRenderedLabel = labels.showRendered
    controls.append(sourceButton)
  })
}

const MAX_PNG_BYTES = 8_000_000
const MAX_PNG_PIXELS = 16_000_000
const MAX_PNG_DIMENSION = 8192

/** 将 KaTeX 的实际渲染节点导出为 PNG，捕获时不包含公式工具栏。 */
export async function downloadMarkdownMathPng(formula: HTMLElement): Promise<void> {
  const rect = formula.getBoundingClientRect()
  const width = rect.width
  const height = rect.height
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('invalid_math_size')
  }
  const pixelRatio = Math.min(
    2,
    MAX_PNG_DIMENSION / width,
    MAX_PNG_DIMENSION / height,
    Math.sqrt(MAX_PNG_PIXELS / (width * height)),
  )
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) throw new Error('png_too_large')

  const backgroundColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--surface-card-solid').trim() || '#ffffff'
  const { toBlob } = await import('html-to-image')
  const blob = await toBlob(formula, { backgroundColor, pixelRatio })
  if (!blob) throw new Error('png_encode_failed')
  if (blob.size > MAX_PNG_BYTES) throw new Error('png_too_large')

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `formula-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function toggleMarkdownMathSource(button: HTMLButtonElement): void {
  const block = button.closest<HTMLElement>('.md-math-block')
  const source = block?.querySelector<HTMLElement>('.md-math-source-view')
  const rendered = block?.querySelector<HTMLElement>('.md-math-result')
  if (!source || !rendered) return
  const showingSource = source.hidden
  source.hidden = !showingSource
  rendered.hidden = showingSource
  const downloadButton = block.querySelector<HTMLButtonElement>('[data-math-action="download-png"]')
  if (downloadButton) downloadButton.disabled = showingSource
  const label = showingSource ? button.dataset.showRenderedLabel : button.dataset.showSourceLabel
  if (label) {
    button.title = label
    button.setAttribute('aria-label', label)
  }
  button.setAttribute('aria-pressed', String(showingSource))
}
