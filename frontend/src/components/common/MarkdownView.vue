<template>
  <div ref="root" class="md-view" v-html="rendered" />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown, sanitizeHtml, sanitizeChatHtml } from '@/utils/markdown'
import { bindMermaidInteractions, cleanupMermaidInteractions } from '@/utils/mermaidInteraction'

// 全站通用的 markdown 展示组件，统一 GuguChat 聊天 / 通知气泡 / 侧边栏通知中心的 md 输出样式。
// - text：原始 markdown 文本，用轻量 renderMarkdown 渲染；
// - html：已预渲染好的 HTML（如 GuguChat 的 hljs 代码高亮 / 流式渲染产物），优先使用。
// 字号用 em 相对父容器，各处只需在外层设 font-size，元素排版（间距/配色/代码块）保持一致。
const props = defineProps({
  text: { type: String, default: '' },
  html: { type: String, default: null },
  // 聊天路径：额外放行 gugu:// 动作链接（由 GuguChat onChatActionClick 处理）；其余仍严格消毒
  chat: { type: Boolean, default: false },
})
const root = ref<HTMLElement | null>(null)
let renderSequence = 0
let themeObserver: MutationObserver | null = null
type MermaidApi = typeof import('mermaid').default
let mermaidApi: MermaidApi | null = null

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidApi) mermaidApi = (await import('mermaid')).default
  return mermaidApi
}

function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme === 'dark'
}

function cssToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function configureMermaid(mermaid: MermaidApi): void {
  const dark = isDarkTheme()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    theme: dark ? 'dark' : 'default',
    themeVariables: {
      primaryColor: cssToken('--surface-card-solid', dark ? '#24212b' : '#ffffff'),
      primaryTextColor: cssToken('--text-primary', dark ? '#f2eff7' : '#272532'),
      primaryBorderColor: cssToken('--border-default', dark ? 'rgba(255,255,255,.16)' : 'rgba(42,35,49,.12)'),
      lineColor: cssToken('--text-secondary', dark ? '#c9c3d5' : '#67647a'),
      secondaryColor: cssToken('--surface-panel', dark ? '#2c2835' : '#f3f2f7'),
      tertiaryColor: cssToken('--surface-hover', dark ? '#363140' : '#ebeaf2'),
      fontFamily: cssToken('--font-family-sans', 'Inter, sans-serif'),
    },
  })
}

async function renderMermaidBlock(element: HTMLElement, source: string): Promise<void> {
  const sequence = ++renderSequence
  element.dataset.renderSequence = String(sequence)
  try {
    const mermaid = await getMermaid()
    configureMermaid(mermaid)
    const { svg } = await mermaid.render(`md-mermaid-${sequence}`, source)
    if (!element.isConnected || element.dataset.renderSequence !== String(sequence)) return
    element.innerHTML = sanitizeHtml(svg)
    bindMermaidInteractions(element)
    element.classList.add('md-mermaid-ready')
    element.classList.remove('md-mermaid-error')
  } catch {
    // 保留源码，避免无效图表把用户内容静默吞掉。
    element.classList.add('md-mermaid-error')
    element.textContent = `Mermaid 图表渲染失败\n\n${source}`
  }
}

async function renderMermaidBlocks(): Promise<void> {
  await nextTick()
  if (!root.value) return
  const sourceBlocks = Array.from(root.value.querySelectorAll<HTMLElement>('.md-mermaid-source'))
  for (const sourceBlock of sourceBlocks) {
    const source = sourceBlock.textContent || ''
    const container = document.createElement('div')
    container.className = 'md-mermaid'
    container.dataset.source = encodeURIComponent(source)
    sourceBlock.replaceWith(container)
  }

  // 主题切换时保留源码并重画，避免 Mermaid 使用旧的亮/暗色配置。
  for (const container of root.value.querySelectorAll<HTMLElement>('.md-mermaid')) {
    const encoded = container.dataset.source
    if (encoded) await renderMermaidBlock(container, decodeURIComponent(encoded))
  }
}
// html 预渲染 prop 同样不可信（来自后端/流式），也必须消毒——不能因「已是 HTML」就跳过
const rendered = computed(() =>
  props.html != null
    ? (props.chat ? sanitizeChatHtml(props.html) : sanitizeHtml(props.html))
    : renderMarkdown(props.text))

watch(rendered, renderMermaidBlocks, { flush: 'post' })

onMounted(() => {
  renderMermaidBlocks()
  themeObserver = new MutationObserver(() => renderMermaidBlocks())
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-family'] })
})

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  themeObserver = null
  cleanupMermaidInteractions(root.value)
  renderSequence += 1
})
</script>

<style scoped>
.md-view { font-size: inherit; line-height: 1.6; word-break: break-word; overflow-wrap: break-word; }
.md-view :deep(> :first-child) { margin-top: 0; }
.md-view :deep(> :last-child)  { margin-bottom: 0; }

.md-view :deep(p) { margin: 0 0 7px; line-height: 1.6; }

.md-view :deep(h1), .md-view :deep(h2), .md-view :deep(h3),
.md-view :deep(h4), .md-view :deep(h5), .md-view :deep(h6) {
  margin: 9px 0 5px; font-weight: 700; line-height: 1.3; color: var(--text-primary);
}
.md-view :deep(h1) { font-size: 1.18em; }
.md-view :deep(h2) { font-size: 1.1em; }
.md-view :deep(h3) { font-size: 1.04em; }
.md-view :deep(h4), .md-view :deep(h5), .md-view :deep(h6) { font-size: 1em; }

.md-view :deep(strong) { font-weight: 700; color: var(--text-primary); }
.md-view :deep(em) { font-style: italic; }
.md-view :deep(del) { text-decoration: line-through; opacity: 0.6; }
.md-view :deep(a) { color: var(--color-primary); text-decoration: underline; text-underline-offset: 2px; }
.md-view :deep(a:hover:not(.chat-object-card)) { opacity: 0.8; }

.md-view :deep(ul), .md-view :deep(ol) { margin: 4px 0 7px; padding-left: 18px; }
.md-view :deep(ul) { list-style: disc; }
.md-view :deep(ol) { list-style: decimal; }
.md-view :deep(li) { margin: 3px 0; line-height: 1.6; display: list-item; }
.md-view :deep(li > p) { margin: 0; }
.md-view :deep(li > ul), .md-view :deep(li > ol) { margin: 2px 0; }

.md-view :deep(code) {
  font-family: var(--font-mono, var(--font-family-mono));
  font-size: 0.88em; background: rgba(123,127,178,0.12);
  color: var(--color-primary); border-radius: 5px; padding: 1px 5px;
}
.md-view :deep(blockquote) {
  margin: 7px 0; padding: 2px 0 2px 10px;
  border-left: 2.5px solid var(--color-primary); color: var(--text-secondary);
}
.md-view :deep(hr) { border: none; border-top: 1px solid rgba(0,0,0,0.1); margin: 9px 0; }

.md-view :deep(table) { border-collapse: collapse; margin: 7px 0; width: 100%; font-size: 0.9em; }
.md-view :deep(th), .md-view :deep(td) { border: 1px solid rgba(0,0,0,0.12); padding: 4px 7px; text-align: left; }
.md-view :deep(th) { background: rgba(123,127,178,0.1); font-weight: 600; }
.md-view :deep(tr:nth-child(even) td) { background: rgba(0,0,0,0.02); }

.md-view :deep(img) { max-width: 100%; max-height: 240px; border-radius: 8px; object-fit: contain; display: block; margin: 4px 0; }

/* 代码块：GuguChat 的 hljs 渲染产物（.md-code-block + 头部语言标签 + 复制按钮 + token 配色）。
   轻量 renderMarkdown 产出的是裸 <pre><code>，由下面的 pre 兜底样式接管。 */
.md-view :deep(pre) { margin: 7px 0; padding: 9px 12px; overflow-x: auto; background: rgba(20,22,40,0.05); border-radius: 8px; }
.md-view :deep(pre code) { background: none; color: var(--text-primary); padding: 0; border-radius: 0; font-size: 0.95em; line-height: 1.6; }
.md-view :deep(.md-mermaid) {
  width: 100%; margin: 9px 0; padding: 10px; box-sizing: border-box;
  overflow-x: auto; border: 1px solid var(--border-default);
  border-radius: 8px; background: var(--surface-card-solid); user-select: none;
}
.md-view :deep(.md-mermaid svg) { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.md-view :deep(.md-mermaid) { position: relative; cursor: default; touch-action: none; }
.md-view :deep(.md-mermaid-dragging) { cursor: grabbing; }
.md-view :deep(.md-mermaid-controls) {
  position: absolute; top: 8px; right: 8px; z-index: 1;
  display: flex; gap: 3px; padding: 3px;
  border: 1px solid var(--border-default); border-radius: 7px;
  background: var(--surface-card-solid); box-shadow: var(--elevation-card);
}
.md-view :deep(.md-mermaid-controls button) {
  width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px;
  color: var(--content-secondary); background: transparent; cursor: pointer;
  font-size: 16px; line-height: 1;
}
.md-view :deep(.md-mermaid-controls button:hover) { color: var(--content-primary); background: var(--surface-soft-hover); }
.md-view :deep(.md-mermaid-error) {
  white-space: pre-wrap; color: var(--text-secondary); font-family: var(--font-family-mono, monospace);
}
.md-view :deep(.md-code-block) { margin: 8px 0; border: 1px solid rgba(123,127,178,0.22); border-radius: 8px; overflow: hidden; background: transparent; font-size: 0.9em; }
.md-view :deep(.md-code-block pre) { margin: 0; background: none; border-radius: 0; }
.md-view :deep(.md-code-header) { display: flex; align-items: center; justify-content: space-between; min-height: 28px; box-sizing: border-box; padding: 5px 12px; background: rgba(123,127,178,0.1); border-bottom: 1px solid rgba(123,127,178,0.16); }
.md-view :deep(.md-code-lang) { margin-right: auto; font-size: 10px; font-weight: 600; color: var(--color-primary); opacity: 0.85; text-transform: lowercase; letter-spacing: 0.04em; }
.md-view :deep(.md-copy-btn) { font-size: 10px; font-weight: 600; color: var(--color-primary); background: none; border: none; cursor: pointer; padding: 0; opacity: 0.7; transition: opacity 0.15s; }
.md-view :deep(.md-copy-btn:hover) { opacity: 1; }
/* token 配色：跟思维面板笔记（useMindEditor.ts + mind-content.css）用同一套，全站代码块
   颜色统一。这里不需要 mind-content.css 里那套"重复 class 提高优先级"的技巧——那是
   为了应付 @tiptap/extension-code-block-lowlight 用 ProseMirror decoration 画高亮、
   把嵌套 token 拍扁成一个 class 列表的问题；GuguChat 是 hljs.highlight() 直接出的
   真实嵌套 <span>，浏览器天然只认最内层，不会有那个问题。 */
.md-view :deep(.hljs-keyword), .md-view :deep(.hljs-literal),
.md-view :deep(.hljs-selector-tag), .md-view :deep(.hljs-tag) { color: #7b5cf0; font-weight: 600; }
.md-view :deep(.hljs-string), .md-view :deep(.hljs-regexp),
.md-view :deep(.hljs-symbol), .md-view :deep(.hljs-bullet),
.md-view :deep(.hljs-addition) { color: #2d7a4f; }
.md-view :deep(.hljs-comment), .md-view :deep(.hljs-quote),
.md-view :deep(.hljs-meta) { color: #9a9a9a; font-style: italic; }
.md-view :deep(.hljs-number), .md-view :deep(.hljs-attr),
.md-view :deep(.hljs-attribute), .md-view :deep(.hljs-deletion) { color: #b07858; }
.md-view :deep(.hljs-function), .md-view :deep(.hljs-name),
.md-view :deep(.hljs-type), .md-view :deep(.hljs-params) { color: #4a7fb5; font-weight: 600; }
.md-view :deep(.hljs-title), .md-view :deep(.hljs-section),
.md-view :deep(.hljs-selector-id), .md-view :deep(.hljs-selector-class) { color: #4a7fb5; font-weight: 600; }
.md-view :deep(.hljs-built_in), .md-view :deep(.hljs-builtin-name),
.md-view :deep(.hljs-link) { color: #5a9e88; }
.md-view :deep(.hljs-variable), .md-view :deep(.hljs-template-variable) { color: #1e2028; }
.md-view :deep(.hljs-emphasis) { font-style: italic; }
.md-view :deep(.hljs-strong) { font-weight: 700; }
</style>
