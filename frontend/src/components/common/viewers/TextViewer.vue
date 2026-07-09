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
    <!-- 代码类扩展名：直接就是 CodeMirror，没有单独的只读预览态——它本身就能当预览用
         （虚拟滚动+增量分词，大文件不卡）。真实文件可编辑，改动自动保存（防抖）；聊天附件等
         非真实文件只读（:disabled，CodeMirror 自己处理成 editable:false + readOnly:true）。 -->
    <template v-else-if="isCodeExt">
      <div class="tv-edit-cm-wrap">
        <Codemirror
          v-model="editText" :extensions="cmExtensions" :disabled="!isRealFile" :indent-with-tab="true"
          @ready="onCmReady" @change="scheduleAutoSave"
        />
      </div>
    </template>
    <!-- md/txt：保留原来的「预览 + 编辑」切换，本来就不大，没必要换 CodeMirror -->
    <template v-else-if="editing">
      <textarea
        ref="editArea" v-model="editText" class="tv-edit-textarea"
        spellcheck="false" @keydown.esc="cancelEdit"
      ></textarea>
      <div class="tv-edit-bar">
        <span v-if="saveError" class="tv-edit-error">{{ saveError }}</span>
        <button class="tv-edit-btn" :disabled="saving" @click="cancelEdit">取消</button>
        <button class="tv-edit-btn tv-edit-save" :disabled="saving" @click="saveEdit">{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </template>
    <div v-else ref="tvScroll" class="tv-scroll" @scroll="onScroll">
      <button v-if="editable" class="tv-edit-toggle" title="编辑" @click="startEdit">
        <PhPencilSimple weight="bold" :size="13" />
      </button>
      <div v-if="truncated" class="tv-notice">仅显示前 500 KB</div>
      <!-- Markdown 渲染 -->
      <div v-if="mdHtml" class="tv-md" v-html="mdHtml" @click="onMdClick" />
      <!-- 纯文本（txt；代码类扩展名走上面的 CodeMirror，不会落到这里） -->
      <table v-else class="tv-table" cellspacing="0">
        <tbody>
          <tr v-for="(line, i) in lines" :key="i">
            <td class="tv-ln">{{ i + 1 }}</td>
            <td class="tv-code">{{ line }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed, defineAsyncComponent } from 'vue'
import { PhWarningCircle, PhPencilSimple } from '@phosphor-icons/vue'
import { filesApi } from '@/services/api'

// CodeMirror 全部延迟加载：TextViewer 从 FloatPreviewWindow 静态引入，FloatPreviewWindow
// 又从 DefaultLayout 静态引入（基本每个登录页都会经过这条链路）——顶层 import codemirror/
// vue-codemirror 会把这些包打进所有用户都要下载的主 chunk，不管有没有用过预览/编辑。跟这个
// 文件里 hljs/marked 已有的做法一致，只在真正点了「编辑」且是代码类扩展名时才动态加载。
const Codemirror = defineAsyncComponent(() => import('vue-codemirror').then(m => m.Codemirror))
let CM = null   // 加载完后缓存 { EditorView, basicSetup }，见 ensureCm()

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

// 能编辑的扩展名：跟后端 app/core/chat_attach.py 的 TEXT_EXTS 保持一致（那边才是真正决定
// PUT /files/{id}/content 接不接受的地方），两边各自维护、改一边记得同步另一边。
const EDITABLE_EXTS = new Set([
  'md', 'txt', 'json', 'csv', 'yaml', 'yml', 'log', 'py', 'js', 'ts', 'tsx', 'jsx',
  'vue', 'html', 'css', 'scss', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'sh',
  'sql', 'xml', 'toml', 'ini', 'conf', 'env', 'tex',
])

// 扩展名 → CodeMirror 语言扩展的按需 loader（编辑用，跟上面 hljs 的 LANG_MAP 是两套独立映射：
// CM6 按语言拆成独立小包，命名和覆盖范围跟 hljs 不是一一对应，且 CM6 官方包覆盖了 hljs 这边
// 没接的 java/go/rust/cpp/sql，编辑时能比只读预览多几种语言的高亮）。没在这张表里的扩展名
// （csv/log/toml/ini/conf/env/tex）用 CodeMirror 编辑但不高亮，比之前退回纯 textarea 依然要好
// （撤销栈、多光标、大文件不卡这些能力还在，只是没有配色）。
const CM_LANG_LOADERS = {
  JS:   () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  JSX:  () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
  TS:   () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
  TSX:  () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true, jsx: true })),
  PY:   () => import('@codemirror/lang-python').then(m => m.python()),
  CSS:  () => import('@codemirror/lang-css').then(m => m.css()),
  SCSS: () => import('@codemirror/lang-css').then(m => m.css()),
  HTML: () => import('@codemirror/lang-html').then(m => m.html()),
  VUE:  () => import('@codemirror/lang-html').then(m => m.html()),   // 没有成熟的 vue SFC 语言包，html 近似
  JSON: () => import('@codemirror/lang-json').then(m => m.json()),
  YAML: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  YML:  () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  XML:  () => import('@codemirror/lang-xml').then(m => m.xml()),
  SQL:  () => import('@codemirror/lang-sql').then(m => m.sql()),
  JAVA: () => import('@codemirror/lang-java').then(m => m.java()),
  GO:   () => import('@codemirror/lang-go').then(m => m.go()),
  RS:   () => import('@codemirror/lang-rust').then(m => m.rust()),
  C:    () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  CPP:  () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  H:    () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  HPP:  () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  SH:   () => Promise.all([import('@codemirror/legacy-modes/mode/shell'), import('@codemirror/language')])
                .then(([{ shell }, { StreamLanguage }]) => StreamLanguage.define(shell)),
}

const lines       = ref([])
const mdHtml      = ref(null)
const rawText     = ref('')   // 源文本（md 勾选任务框改写 [ ]↔[x]、md/txt 编辑模式的保存基于这个）
// 真实文件（纯数字 id）才能存——聊天附件是 16 位 hex，PUT /files/{id}/content 存不了
const isRealFile = computed(() => /^\d+$/.test(String(props.fileKey ?? '')))
// 可交互勾选 = md 文件 + 真实文件
const savable  = computed(() => /^(md|markdown)$/i.test(props.ext || '') && isRealFile.value)
// 可编辑 = 后端认得的文本类扩展名 + 真实文件（md/txt 走「编辑」按钮切换态用得到；代码类扩展名
// 不看这个——代码文件不管是不是真实文件都直接显示 CodeMirror，只是能不能保存的区别，见 isCodeExt）
const editable = computed(() => EDITABLE_EXTS.has((props.ext || '').toLowerCase()) && isRealFile.value)
const isMarkdownFile = computed(() => /^(md|markdown)$/i.test(props.ext || ''))
// 代码类扩展名：不分真实文件/聊天附件、不分编辑/预览，一律直接显示 CodeMirror——它本身既能当
// 预览用（只读态），也能编辑（真实文件时），不需要 .tv-table + 单独编辑框这套双视图。
// md/txt 太小，双视图切换本来就没问题，不用换。
const isCodeExt = computed(() => {
  const e = (props.ext || '').toLowerCase()
  return EDITABLE_EXTS.has(e) && e !== 'md' && e !== 'markdown' && e !== 'txt'
})
const loading     = ref(false)
const error       = ref(null)
const truncated   = ref(false)

// ── 编辑模式：md/txt 的「预览+编辑」切换态，见 editable；代码类扩展名见 isCodeExt（没有切换态） ──
const editing   = ref(false)
const editText  = ref('')
const editArea  = ref(null)   // md/txt 用的纯文本 textarea
const saving    = ref(false)
const saveError = ref('')

const cmView       = ref(null)   // 当前 CodeMirror 的 EditorView 实例（@ready 拿到）
const cmExtensions = ref([])     // 基础扩展 + 按需加载的语言扩展，进编辑态前异步准备好

// vue-codemirror 的 <Codemirror> 组件内部本来就默认带了一份 basicSetup（含行号+代码折叠两个
// gutter），跟组件本身无关、不受 :extensions 传参影响；不要自己再传 basicSetup（或任何行号类
// 扩展），只在 :extensions 里加主题和语法高亮配色，行号/折叠/撤销栈交给组件内置的那份就够。
async function ensureCm() {
  if (!CM) {
    const [{ EditorView }, { defaultHighlightStyle, syntaxHighlighting }] = await Promise.all([
      import('@codemirror/view'),
      import('@codemirror/language'),
    ])
    CM = { EditorView, highlighting: syntaxHighlighting(defaultHighlightStyle, { fallback: true }) }
  }
  return CM
}

async function loadCmExtensions(ext) {
  const cm = await ensureCm()
  const theme = cm.EditorView.theme({
    '&': { height: '100%', fontSize: 'var(--tv-font-size, 13px)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': { fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,monospace" },
    '.cm-scroller': { overflow: 'auto' },
    // 组件内置的 basicSetup 除了行号还带一个代码折叠 gutter，用不上，隐藏掉不留预留空白
    '.cm-foldGutter': { display: 'none' },
  })
  const loader = CM_LANG_LOADERS[(ext || '').toUpperCase()]
  const langExt = loader ? await loader() : null
  cmExtensions.value = [theme, cm.highlighting, ...(langExt ? [langExt] : [])]
}
function onCmReady({ view }) {
  cmView.value = view
}

// 代码文件自动保存（防抖，改一下等 800ms 没有新改动再存，不是敲一个字符存一次）。fileKey/待存
// 内容在「排队时」（每次改动都会重新排一次）就地闭包捕获，不是等定时器触发才现读——就算这中间
// 文件被切走（props.fileKey/editText 已经变成新文件的），排队中的这次还是会把旧文件的旧内容存
// 到旧文件自己的 id 上，不会存错文件。没有保存中/已保存的 UI 提示；失败了只打 console，不打扰
// 编辑——真要盯保存状态可以开 devtools 看。
let autoSaveTimer = null

function scheduleAutoSave() {
  if (!isRealFile.value) return
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  const targetKey = props.fileKey
  const content   = editText.value
  autoSaveTimer = setTimeout(() => { autoSaveTimer = null; doAutoSave(targetKey, content) }, 800)
}
async function doAutoSave(targetKey, content) {
  try {
    await filesApi.saveContent(Number(targetKey), content)
    rawText.value = content
  } catch (e) {
    console.error('[TextViewer] 自动保存失败:', e)
  }
}

// md/txt 的预览/编辑双视图是两套独立 DOM，进出编辑态要把滚动位置对上：md 渲染成 HTML 后跟源码
// 行号没有线性对应关系（标题/段落/代码块各自高度不同），只能按滚动比例（scrollTop / 可滚动
// 距离）估算；txt 是等高的行号表格，能精确算「顶部是第几行」，textarea 按自己的行高换算对应。
let scrollFrac  = 0     // md 用
let pendingLine = 0     // txt 用

function rowHeightOf(el) {
  if (!el) return 0
  if (el.tagName === 'TEXTAREA') return parseFloat(getComputedStyle(el).lineHeight) || 0
  const tr = el.querySelector('tr')
  return tr ? tr.getBoundingClientRect().height : 0
}
function captureScroll(el) {
  if (isMarkdownFile.value) {
    const max = el ? el.scrollHeight - el.clientHeight : 0
    scrollFrac = (el && max > 0) ? el.scrollTop / max : 0
    return
  }
  const rh = rowHeightOf(el)
  pendingLine = (el && rh) ? Math.round(el.scrollTop / rh) : 0
}
function applyScroll(el) {
  if (!el) return
  if (isMarkdownFile.value) {
    const max = el.scrollHeight - el.clientHeight
    el.scrollTop = max > 0 ? scrollFrac * max : 0
    return
  }
  const rh = rowHeightOf(el)
  el.scrollTop = rh ? pendingLine * rh : 0
}

async function startEdit() {
  captureScroll(tvScroll.value)
  editText.value = rawText.value
  saveError.value = ''
  editing.value = true
  await nextTick()
  editArea.value?.focus()
  applyScroll(editArea.value)
}
function cancelEdit() {
  captureScroll(editArea.value)
  editing.value = false
  nextTick(() => applyScroll(tvScroll.value))
}
async function saveEdit() {
  saving.value = true
  saveError.value = ''
  try {
    captureScroll(editArea.value)
    await filesApi.saveContent(Number(props.fileKey), editText.value)
    await processText(editText.value, props.ext)
    editing.value = false
    await nextTick()
    applyScroll(tvScroll.value)
  } catch (e) {
    saveError.value = '保存失败：' + (e.message || '未知错误')
  } finally {
    saving.value = false
  }
}

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
// 用 `new Marked()` 建一个独立实例，绝不能 `import { marked } from 'marked'` 再 `.use()`——
// 那是全站共享的默认单例，GuguChat 聊天气泡自己也在同一个单例上注册了 code 渲染器
// （纯文字按钮，没有 md-pre/md-copy-icon 这些 class）。两边都调 .use() 会互相覆盖全局配置：
// 谁后调用谁生效，一旦用户此前打开过一次文件预览，这里的渲染器就会全局顶替掉聊天的，之后聊天
// 消息里的代码块复制按钮就会带着这里的 SVG 图标出现——但聊天的 CSS 没给这几个 class 定过尺寸，
// 图标就会没有约束地放大。真实症状：GuguChat 里代码块偶尔冒出一个巨大的图标（devlog 2026-07-10）。
let _tvMarked = null

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

  if (!_tvMarked) {
    const { Marked } = await import('marked')
    _tvMarked = new Marked({
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
  }

  return _tvMarked.parse(text)
}

// ── 任务勾选框可交互：去掉 marked 默认的 disabled、按文档顺序标 data-task（仅 md + 真实文件）──
function makeTasksInteractive(html) {
  if (!savable.value) return html
  let i = 0
  return html.replace(/<input\b[^>]*?type="checkbox"[^>]*?>/gi, (tag) =>
    tag.replace(/\sdisabled(="[^"]*")?/i, '').replace(/^<input/i, `<input data-task="${i++}"`)
  )
}

const _TASK_RE = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/
// 勾第 idx 个任务（文档顺序）：按勾选框的新状态翻转源里对应行 [ ]↔[x]、回存文件；存失败回滚视觉
async function toggleTask(idx, cb) {
  const ls = rawText.value.split('\n')
  let n = -1, hit = -1
  for (let li = 0; li < ls.length; li++) {
    if (_TASK_RE.test(ls[li]) && ++n === idx) { hit = li; break }
  }
  if (hit < 0) return
  const before = rawText.value
  ls[hit] = ls[hit].replace(/\[[ xX]\]/, cb.checked ? '[x]' : '[ ]')
  rawText.value = ls.join('\n')
  try {
    await filesApi.saveContent(Number(props.fileKey), rawText.value)
  } catch {
    rawText.value = before          // 存失败 → 回滚源 + 视觉
    cb.checked = !cb.checked
  }
}

// ── md 区域点击（事件委托）：任务勾选框 → 切换+存；复制按钮 → 复制代码 ──
function onMdClick(e) {
  const cb = e.target.closest('input[type="checkbox"][data-task]')
  if (cb) { toggleTask(Number(cb.dataset.task), cb); return }   // 不 preventDefault：原生勾选即时显示
  const btn = e.target.closest('.md-copy-btn')
  if (!btn) return
  const code = btn.closest('.md-pre')?.querySelector('code')?.textContent ?? ''
  navigator.clipboard.writeText(code).then(() => {
    btn.classList.add('md-copied')
    setTimeout(() => btn.classList.remove('md-copied'), 2000)
  })
}

// 把一段文本渲染成 mdHtml / 纯文本行（首次加载、md/txt 编辑保存后重渲都走这条）。代码类扩展名
// 不在这里处理——它们直接显示 CodeMirror，不需要 mdHtml/lines 这套只读渲染，见 isCodeExt。
async function processText(text, ext) {
  mdHtml.value  = null
  lines.value   = []
  rawText.value = text
  const extUp = (ext || '').toUpperCase()

  if (extUp === 'MD') {
    mdHtml.value = makeTasksInteractive(await renderMarkdown(text))
  } else if (!isCodeExt.value) {
    lines.value = text.split('\n')
  }
}

watch(() => [props.blobUrl, props.ext], async ([url, ext]) => {
  if (!url) return
  loading.value   = true
  error.value     = null
  truncated.value = false
  editing.value   = false   // 切换文件/重新加载时退出编辑态，别把上一份文件的编辑框留着
  cmView.value    = null
  saveError.value = ''

  try {
    const res  = await fetch(url)
    const buf  = await res.arrayBuffer()
    truncated.value = buf.byteLength > MAX_BYTES
    const slice = truncated.value ? buf.slice(0, MAX_BYTES) : buf
    const text  = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    await processText(text, ext)
    if (isCodeExt.value) {
      // 代码类扩展名没有单独的只读渲染，CodeMirror 直接从 editText 显示——加载完就把内容和
      // 对应语言扩展准备好，不用等用户点什么「编辑」
      editText.value = text
      await loadCmExtensions(ext)
    }
  } catch (e) {
    error.value = '读取失败：' + e.message
  } finally {
    loading.value = false
  }
  // 渲染完从 localStorage 还原该文件的滚动位置（新内容更短时浏览器自动夹到底部）——只对 md/txt
  // 的 .tv-scroll 有意义，代码文件走 CodeMirror 自己的视图，这段对它是 no-op（tvScroll 是 null）
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

/* ── 编辑入口（浮在只读视图右上角） ── */
.tv-edit-toggle {
  position: absolute; top: 10px; right: 14px; z-index: 2;
  width: 26px; height: 26px; border-radius: 7px;
  border: none; background: rgba(123,127,178,0.1); color: rgba(80,85,130,0.6);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.tv-edit-toggle:hover { background: rgba(123,127,178,0.2); color: rgba(80,85,130,0.9); }

/* ── 编辑模式：纯文本框 + 底部操作条 ── */
.tv-edit-textarea {
  flex: 1; width: 100%; box-sizing: border-box;
  border: none; outline: none; resize: none;
  padding: 20px 24px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
  font-size: var(--tv-font-size, 13px);
  line-height: 1.7; color: #383a42; background: #fff;
}
.tv-edit-bar {
  flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid rgba(0,0,0,0.06); background: #f7f7fb;
}
.tv-edit-error { flex: 1; font-size: 12px; color: rgba(180,80,80,0.85); }
.tv-edit-btn {
  padding: 6px 16px; border-radius: 8px; font-size: 12px; font-weight: 600;
  border: 1px solid rgba(0,0,0,0.08); background: #fff; color: var(--text-secondary);
  cursor: pointer; transition: background 0.12s;
}
.tv-edit-btn:hover:not(:disabled) { background: rgba(0,0,0,0.03); }
.tv-edit-btn:disabled { opacity: 0.5; cursor: default; }
.tv-edit-save {
  border-color: transparent; color: #fff;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
}
.tv-edit-save:hover:not(:disabled) { opacity: 0.92; background: linear-gradient(135deg, #7b7fb2, #9590c4); }

/* ── 代码文件编辑：CodeMirror（字体/字号走 theme 里的 --tv-font-size，容器负责撑满高度） ── */
.tv-edit-cm-wrap { flex: 1; overflow: hidden; }
.tv-edit-cm-wrap :deep(.cm-editor) { height: 100%; }

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
/* marked 18 不输出 task-list-item/contains-task-list class，故用 :has 选「含勾选框的 li」去 bullet + flex 对齐 */
.tv-md :deep(li:has(> input[type="checkbox"])) {
  list-style: none;
  display: flex; align-items: baseline; gap: 8px;
}
/* 风格与注册页确认勾选框（.ack-box）一致：16px 圆角 5px、紫灰边白底、选中紫色渐变 + 阴影 + 白勾 */
.tv-md :deep(input[type="checkbox"]) {
  appearance: none; -webkit-appearance: none;
  width: 16px; height: 16px;
  border: 1.5px solid rgba(123, 127, 178, 0.35);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.6);
  flex-shrink: 0;
  position: relative;
  top: 2px;
  cursor: default;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
/* 可交互勾选框（md + 真实文件）：手型 + hover 提示可点 */
.tv-md :deep(input[type="checkbox"][data-task]) { cursor: pointer; }
.tv-md :deep(input[type="checkbox"][data-task]:hover) { border-color: rgba(123, 127, 178, 0.6); }
.tv-md :deep(input[type="checkbox"]:checked) {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border-color: transparent;
  box-shadow: 0 2px 8px rgba(123, 127, 178, 0.35);
}
/* 勾用注册页同一条 SVG polyline（圆头折线），保证 icon 一致 */
.tv-md :deep(input[type="checkbox"]:checked::after) {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='10'%20height='10'%20viewBox='0%200%2010%2010'%20fill='none'%3E%3Cpolyline%20points='1.5,5%204,7.5%208.5,2.5'%20stroke='white'%20stroke-width='1.6'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: center;
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
