<template>
  <div class="tv-wrap">
    <div v-if="loading" class="tv-status">
      <div class="tv-spinner" />
      <span>加载中…</span>
    </div>
    <div v-else-if="error" class="tv-status tv-error">
      <PhWarningCircle :size="28" style="opacity:.5" />
      <span>{{ error }}</span>
    </div>
    <div v-else ref="tvScroll" class="tv-scroll" @scroll="onScroll">
      <div v-if="truncated" class="tv-notice">仅显示前 500 KB</div>
      <!-- Markdown 渲染 -->
      <div v-if="mdHtml" class="tv-md" v-html="mdHtml" @click="onMdClick" />
      <!-- 代码 / 纯文本 -->
      <table v-else class="tv-table" cellspacing="0">
        <tbody>
          <tr v-for="(line, i) in lines" :key="i">
            <td class="tv-ln">{{ i + 1 }}</td>
            <td v-if="highlighted" class="tv-code tv-code--hl" v-html="line" />
            <td v-else class="tv-code">{{ line }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { PhWarningCircle } from '@phosphor-icons/vue'

const MAX_BYTES = 500 * 1024

const props = defineProps({
  blobUrl:  { type: String, default: null },
  ext:      { type: String, default: null },
  fontSize: { type: Number, default: 13 },
  // 文件标识：滚动位置按它存进 localStorage，刷新（重载/组件重建）后据此还原
  fileKey:  { type: [String, Number], default: null },
})

const tvScroll = ref(null)   // .tv-scroll 滚动容器

// 滚动位置持久化到 localStorage：实时刷新会把 blobUrl 置空、整组件销毁重建，内存变量留不住，
// 只有 localStorage 跨重建（甚至跨整页刷新）还在。按 fileKey 存，渲染完读回。
const _posKey = () => (props.fileKey != null ? 'tvpos:' + props.fileKey : null)
let _saveQueued = false
function onScroll() {
  if (_saveQueued) return
  _saveQueued = true
  requestAnimationFrame(() => {
    _saveQueued = false
    const k = _posKey()
    if (k && tvScroll.value) { try { localStorage.setItem(k, String(Math.round(tvScroll.value.scrollTop))) } catch {} }
  })
}

// 扩展名 → highlight.js 语言名
const LANG_MAP = {
  JS: 'javascript', JSX: 'javascript',
  TS: 'typescript', TSX: 'typescript',
  CSS: 'css', SCSS: 'scss',
  HTML: 'xml', VUE: 'xml',
  PY: 'python',
  YAML: 'yaml', YML: 'yaml',
  XML: 'xml',
  SH: 'bash', BASH: 'bash',
  JSON: 'json',
}

// highlight.js 按需注册的语言
const LANG_LOADERS = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  css:        () => import('highlight.js/lib/languages/css'),
  xml:        () => import('highlight.js/lib/languages/xml'),
  python:     () => import('highlight.js/lib/languages/python'),
  yaml:       () => import('highlight.js/lib/languages/yaml'),
  bash:       () => import('highlight.js/lib/languages/bash'),
  json:       () => import('highlight.js/lib/languages/json'),
  scss:       () => import('highlight.js/lib/languages/scss'),
}

const lines       = ref([])
const mdHtml      = ref(null)
const loading     = ref(false)
const error       = ref(null)
const truncated   = ref(false)
const highlighted = ref(false)

let hljs = null

async function ensureHljs(lang) {
  if (!hljs) {
    const mod = await import('highlight.js/lib/core')
    hljs = mod.default
  }
  if (!hljs.getLanguage(lang) && LANG_LOADERS[lang]) {
    const mod = await LANG_LOADERS[lang]()
    hljs.registerLanguage(lang, mod.default)
  }
}

// ── HTML 转义 ────────────────────────────────────────
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── SVG 图标 ─────────────────────────────────────────
const ICON_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`

// ── Markdown 渲染（含语法高亮 + 复制按钮）────────────
async function renderMarkdown(text) {
  // 先确保 hljs core 已加载，然后批量注册所有支持的语言
  if (!hljs) {
    const mod = await import('highlight.js/lib/core')
    hljs = mod.default
  }
  await Promise.all(
    Object.entries(LANG_LOADERS).map(async ([name, loader]) => {
      if (!hljs.getLanguage(name)) {
        const mod = await loader()
        hljs.registerLanguage(name, mod.default)
      }
    })
  )

  const { marked } = await import('marked')

  marked.use({
    renderer: {
      code({ text, lang }) {
        const validLang = lang && hljs.getLanguage(lang) ? lang : null
        const body = validLang
          ? hljs.highlight(text, { language: validLang, ignoreIllegals: true }).value
          : escHtml(text)
        const badge = validLang
          ? `<span class="md-code-lang">${validLang}</span>`
          : ''
        const btn = `<button class="md-copy-btn" title="复制">
          <span class="md-copy-icon">${ICON_COPY}</span>
          <span class="md-check-icon">${ICON_CHECK}</span>
        </button>`
        return `<pre class="md-pre">${badge}${btn}<code>${body}</code></pre>`
      },
    },
    gfm: true,
    breaks: false,
  })

  return marked.parse(text)
}

// ── 复制按钮点击（事件委托）─────────────────────────
function onMdClick(e) {
  const btn = e.target.closest('.md-copy-btn')
  if (!btn) return
  const code = btn.closest('.md-pre')?.querySelector('code')?.textContent ?? ''
  navigator.clipboard.writeText(code).then(() => {
    btn.classList.add('md-copied')
    setTimeout(() => btn.classList.remove('md-copied'), 2000)
  })
}

// 将 highlight.js 输出的 HTML 按行拆分，保持 span 标签完整闭合
function splitHtmlLines(html) {
  const result = []
  let openSpans = []

  for (const line of html.split('\n')) {
    const prefix = openSpans.map(cls => `<span class="${cls}">`).join('')
    const stack  = [...openSpans]

    const tagRe = /<span class="([^"]+)">|<\/span>/g
    let m
    while ((m = tagRe.exec(line)) !== null) {
      if (m[0].startsWith('</')) stack.pop()
      else stack.push(m[1])
    }

    const suffix = stack.map(() => '</span>').join('')
    result.push(prefix + line + suffix)
    openSpans = stack
  }

  return result
}

watch(() => [props.blobUrl, props.ext], async ([url, ext]) => {
  if (!url) return
  loading.value     = true
  error.value       = null
  truncated.value   = false
  highlighted.value = false
  mdHtml.value      = null
  lines.value       = []

  try {
    const res  = await fetch(url)
    const buf  = await res.arrayBuffer()
    truncated.value = buf.byteLength > MAX_BYTES
    const slice = truncated.value ? buf.slice(0, MAX_BYTES) : buf
    const text  = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    const extUp = ext?.toUpperCase()

    if (extUp === 'MD') {
      mdHtml.value = await renderMarkdown(text)
    } else {
      const lang = LANG_MAP[extUp]
      if (lang) {
        await ensureHljs(lang)
        const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        lines.value       = splitHtmlLines(html)
        highlighted.value = true
      } else {
        lines.value = text.split('\n')
      }
    }
  } catch (e) {
    error.value = '读取失败：' + e.message
  } finally {
    loading.value = false
  }
  // 渲染完从 localStorage 还原该文件的滚动位置（新内容更短时浏览器自动夹到底部）
  const k = _posKey()
  const saved = k ? parseInt(localStorage.getItem(k) || '0', 10) : 0
  if (saved > 0) {
    await nextTick()
    requestAnimationFrame(() => { if (tvScroll.value) tvScroll.value.scrollTop = saved })
  }
}, { immediate: true })
</script>

<style scoped>
.tv-wrap {
  position: absolute;
  inset: 0;
  background: #fff;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  --tv-font-size: v-bind('props.fontSize + "px"');
}

.tv-scroll {
  flex: 1;
  overflow: auto;
  padding: 0 0 16px;
  will-change: scroll-position;
  user-select: text;            /* 覆盖预览弹窗容器的 user-select:none，让正文可选/复制 */
  -webkit-user-select: text;    /* 行号 .tv-ln 单独 none，不会被选进去 */
}

.tv-notice {
  font-size: 11px;
  color: var(--text-secondary);
  background: rgba(240, 180, 80, 0.12);
  border-bottom: 1px solid rgba(240, 180, 80, 0.25);
  padding: 6px 20px;
  margin-bottom: 8px;
}

.tv-table {
  width: 100%;
  border-collapse: collapse;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
  font-size: var(--tv-font-size, 13px);
  line-height: 1.7;
}

.tv-ln {
  width: 1%;
  min-width: 48px;
  padding: 0 16px 0 20px;
  text-align: right;
  color: rgba(120, 124, 160, 0.45);
  white-space: nowrap;
  user-select: none;
  border-right: 1px solid rgba(0, 0, 0, 0.06);
  vertical-align: top;
  position: sticky;
  left: 0;
  background: #f2f3f8;
}

.tv-code {
  padding: 0 24px 0 16px;
  white-space: pre;
  color: #383a42;
  vertical-align: top;
}

tr:hover .tv-ln  { background: #eaebf2; }
tr:hover .tv-code { background: rgba(100, 110, 200, 0.04); }

/* ── highlight.js 配色（atom-one-light 风格） ── */
.tv-code--hl :deep(.hljs-comment),
.tv-code--hl :deep(.hljs-quote)          { color: #a0a1a7; font-style: italic; }

.tv-code--hl :deep(.hljs-keyword),
.tv-code--hl :deep(.hljs-selector-tag),
.tv-code--hl :deep(.hljs-built_in),
.tv-code--hl :deep(.hljs-name),
.tv-code--hl :deep(.hljs-tag)            { color: #a626a4; }

.tv-code--hl :deep(.hljs-string),
.tv-code--hl :deep(.hljs-title),
.tv-code--hl :deep(.hljs-section),
.tv-code--hl :deep(.hljs-attribute),
.tv-code--hl :deep(.hljs-literal),
.tv-code--hl :deep(.hljs-template-tag),
.tv-code--hl :deep(.hljs-template-variable),
.tv-code--hl :deep(.hljs-type),
.tv-code--hl :deep(.hljs-addition)       { color: #50a14f; }

.tv-code--hl :deep(.hljs-deletion),
.tv-code--hl :deep(.hljs-selector-class),
.tv-code--hl :deep(.hljs-doctag),
.tv-code--hl :deep(.hljs-number),
.tv-code--hl :deep(.hljs-regexp),
.tv-code--hl :deep(.hljs-variable),
.tv-code--hl :deep(.hljs-symbol),
.tv-code--hl :deep(.hljs-bullet)         { color: #e45649; }

.tv-code--hl :deep(.hljs-link),
.tv-code--hl :deep(.hljs-selector-id),
.tv-code--hl :deep(.hljs-title.class_),
.tv-code--hl :deep(.hljs-class .hljs-title) { color: #c18401; }

.tv-code--hl :deep(.hljs-emphasis)       { font-style: italic; }
.tv-code--hl :deep(.hljs-strong)         { font-weight: bold; }

/* ── Markdown 渲染 ── */
.tv-md {
  padding: 32px 48px;
  max-width: 860px;
  margin: 0 auto;
  color: #24292f;
  font-size: var(--tv-font-size, 15px);
  line-height: 1.75;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.tv-md :deep(h1),
.tv-md :deep(h2),
.tv-md :deep(h3),
.tv-md :deep(h4) {
  font-weight: 600;
  margin: 1.5em 0 0.5em;
  line-height: 1.3;
  color: #1a1c24;
}
.tv-md :deep(h1) { font-size: 1.8em; border-bottom: 1px solid rgba(0,0,0,0.08); padding-bottom: 0.3em; }
.tv-md :deep(h2) { font-size: 1.4em; border-bottom: 1px solid rgba(0,0,0,0.06); padding-bottom: 0.25em; }
.tv-md :deep(h3) { font-size: 1.15em; }

.tv-md :deep(p)  { margin: 0.8em 0; }
.tv-md :deep(a)  { color: #4c7ef3; text-decoration: none; }
.tv-md :deep(a:hover) { text-decoration: underline; }

/* 行内代码 */
.tv-md :deep(code) {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.875em;
  background: rgba(100, 110, 200, 0.08);
  border-radius: 4px;
  padding: 0.15em 0.4em;
  color: #a626a4;
}

/* 代码块容器 */
.tv-md :deep(.md-pre) {
  position: relative;
  background: #f0f1f6;
  border-radius: 10px;
  margin: 1em 0;
  overflow: hidden;
}
.tv-md :deep(.md-pre code) {
  display: block;
  padding: 14px 20px 16px;
  overflow-x: auto;
  background: none;
  color: #383a42;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.65;
}

/* 语言标签 */
.tv-md :deep(.md-code-lang) {
  position: absolute;
  top: 10px;
  left: 14px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(60, 65, 100, 0.4);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  pointer-events: none;
  user-select: none;
}
/* 有语言标签时代码区域下移 */
.tv-md :deep(.md-pre:has(.md-code-lang) code) {
  padding-top: 30px;
}

/* 复制按钮 */
.tv-md :deep(.md-copy-btn) {
  position: absolute;
  top: 8px;
  right: 10px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: rgba(80, 85, 130, 0.4);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px;
  transition: background 0.12s, color 0.12s;
  opacity: 0;
}
.tv-md :deep(.md-pre:hover .md-copy-btn) { opacity: 1; }
.tv-md :deep(.md-copy-btn:hover) {
  background: rgba(100, 110, 200, 0.1);
  color: rgba(80, 85, 130, 0.8);
}
.tv-md :deep(.md-copy-btn svg) { width: 14px; height: 14px; }
.tv-md :deep(.md-check-icon) { display: none; }
.tv-md :deep(.md-copy-icon) { display: flex; }
.tv-md :deep(.md-copy-btn.md-copied) { color: #50a14f; }
.tv-md :deep(.md-copy-btn.md-copied .md-copy-icon) { display: none; }
.tv-md :deep(.md-copy-btn.md-copied .md-check-icon) { display: flex; }

/* highlight.js 配色（代码块内） */
.tv-md :deep(.hljs-comment),
.tv-md :deep(.hljs-quote)          { color: #a0a1a7; font-style: italic; }
.tv-md :deep(.hljs-keyword),
.tv-md :deep(.hljs-selector-tag),
.tv-md :deep(.hljs-built_in),
.tv-md :deep(.hljs-name),
.tv-md :deep(.hljs-tag)            { color: #a626a4; }
.tv-md :deep(.hljs-string),
.tv-md :deep(.hljs-title),
.tv-md :deep(.hljs-attribute),
.tv-md :deep(.hljs-literal),
.tv-md :deep(.hljs-type),
.tv-md :deep(.hljs-addition)       { color: #50a14f; }
.tv-md :deep(.hljs-number),
.tv-md :deep(.hljs-regexp),
.tv-md :deep(.hljs-variable),
.tv-md :deep(.hljs-symbol),
.tv-md :deep(.hljs-deletion)       { color: #e45649; }
.tv-md :deep(.hljs-link),
.tv-md :deep(.hljs-title.class_),
.tv-md :deep(.hljs-class .hljs-title) { color: #c18401; }
.tv-md :deep(.hljs-emphasis)       { font-style: italic; }
.tv-md :deep(.hljs-strong)         { font-weight: bold; }

/* task list */
.tv-md :deep(ul.contains-task-list) { list-style: none; padding-left: 0.5em; }
.tv-md :deep(li.task-list-item) { display: flex; align-items: baseline; gap: 8px; }
.tv-md :deep(li.task-list-item input[type="checkbox"]) {
  appearance: none;
  width: 14px; height: 14px;
  border: 1.5px solid rgba(100, 110, 200, 0.4);
  border-radius: 3px;
  flex-shrink: 0;
  position: relative;
  top: 2px;
  cursor: default;
}
.tv-md :deep(li.task-list-item input[type="checkbox"]:checked) {
  background: rgba(100, 110, 200, 0.7);
  border-color: rgba(100, 110, 200, 0.7);
}
.tv-md :deep(li.task-list-item input[type="checkbox"]:checked::after) {
  content: '';
  position: absolute;
  left: 3px; top: 1px;
  width: 6px; height: 4px;
  border-left: 1.5px solid white;
  border-bottom: 1.5px solid white;
  transform: rotate(-45deg);
}

.tv-md :deep(blockquote) {
  margin: 1em 0;
  padding: 0 1em;
  border-left: 3px solid rgba(100, 110, 200, 0.35);
  color: rgba(36, 41, 47, 0.6);
}

.tv-md :deep(ul),
.tv-md :deep(ol) { padding-left: 1.8em; margin: 0.5em 0; }
.tv-md :deep(li) { margin: 0.25em 0; }

.tv-md :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
  font-size: 14px;
}
.tv-md :deep(th),
.tv-md :deep(td) {
  padding: 8px 14px;
  border: 1px solid rgba(0,0,0,0.1);
  text-align: left;
}
.tv-md :deep(th) { background: rgba(100,110,200,0.06); font-weight: 600; }
.tv-md :deep(tr:hover td) { background: rgba(100,110,200,0.03); }

.tv-md :deep(hr) {
  border: none;
  border-top: 1px solid rgba(0,0,0,0.1);
  margin: 1.5em 0;
}

.tv-md :deep(img) { max-width: 100%; border-radius: 6px; }

/* ── 状态 ── */
.tv-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
  font-size: 13px;
}
.tv-error { color: rgba(180, 80, 80, 0.8); }
.tv-spinner {
  width: 24px; height: 24px; border-radius: 50%;
  border: 2px solid rgba(123, 127, 178, 0.2);
  border-top-color: rgba(123, 127, 178, 0.7);
  animation: tv-spin 0.7s linear infinite;
}
@keyframes tv-spin { to { transform: rotate(360deg); } }
</style>
