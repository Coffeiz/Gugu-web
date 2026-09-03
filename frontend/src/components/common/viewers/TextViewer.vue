<template>
  <div class="tv-wrap">
    <div v-if="loading" class="tv-status">
      <div class="tv-spinner" />
      <span>{{ t('viewerUi.loading') }}</span>
    </div>
    <div v-else-if="error" class="tv-status tv-error">
      <Icon name="status.warning" :size="28" style="opacity:.5" />
      <span>{{ error }}</span>
    </div>
    <!-- 代码类扩展名：直接就是 CodeMirror，没有单独的只读预览态——它本身就能当预览用
         （虚拟滚动+增量分词，大文件不卡）。真实文件可编辑，改动自动保存（防抖）；聊天附件等
         非真实文件只读（:disabled，CodeMirror 自己处理成 editable:false + readOnly:true）。 -->
    <template v-else-if="isCodeExt">
      <div class="tv-edit-cm-wrap">
        <Codemirror
          v-model="editText" :extensions="cmExtensions" :disabled="!isEditableDocument" :indent-with-tab="true"
          @ready="onCmReady" @change="scheduleAutoSave"
        />
      </div>
    </template>
    <!-- Markdown 编辑复用 CodeMirror 的语法高亮。 -->
    <template v-else-if="editing && isMarkdownFile">
      <div class="tv-edit-cm-wrap">
        <Codemirror
          v-if="mdEditorReady"
          v-model="editText" :extensions="cmExtensions" :disabled="!isEditableDocument"
          @ready="onCmReady"
        />
        <div v-else class="tv-editor-loading">{{ t('viewerUi.markdownHighlighting') }}</div>
      </div>
      <div class="tv-edit-bar">
        <span v-if="saveError" class="tv-edit-error">{{ saveError }}</span>
        <button class="tv-edit-btn" :disabled="saving" @click="cancelEdit">{{ t('viewerUi.cancel') }}</button>
        <button class="tv-edit-btn tv-edit-save" :disabled="saving" @click="saveEdit">{{ saving ? t('viewerUi.saving') : t('viewerUi.save') }}</button>
      </div>
    </template>
    <div v-else ref="tvScroll" class="tv-scroll" @scroll="onScroll">
      <button v-if="editable" class="tv-edit-toggle" :title="t('viewerUi.edit')" @click="startEdit">
        <Icon name="action.edit" :size="13" />
      </button>
      <div v-if="truncated" class="tv-notice">{{ t('viewerUi.truncated') }}</div>
      <!-- Markdown 渲染；txt/代码类扩展名走上面的 CodeMirror，不会落到这里 -->
      <div v-if="mdHtml" ref="mdRoot" class="tv-md" v-html="mdHtml" @click="onMdClick" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed, defineAsyncComponent, onMounted, onBeforeUnmount, type PropType } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import { filesApi } from '@/services/api'
import { sanitizeHtml } from '@/utils/markdown'
import { bindMermaidInteractions, cleanupMermaidInteractions } from '@/utils/mermaidInteraction'
import { useFilesCacheStore, type FileMeta } from '@/stores/filesCache'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import { useUiStore } from '@/stores/ui'
import { resolveRelativeFileLink } from '@/utils/fileLinks'

const { t } = useI18n()

// CodeMirror 全部延迟加载：TextViewer 从 FloatPreviewWindow 静态引入，FloatPreviewWindow
// 又从 DefaultLayout 静态引入（基本每个登录页都会经过这条链路）——顶层 import codemirror/
// vue-codemirror 会把这些包打进所有用户都要下载的主 chunk，不管有没有用过预览/编辑。跟这个
// 文件里 hljs/marked 已有的做法一致，只在真正点了「编辑」且是代码类扩展名时才动态加载。
const Codemirror = defineAsyncComponent(() => import('vue-codemirror').then(m => m.Codemirror))
let CM: any = null   // 加载完后缓存 { EditorView, basicSetup }，见 ensureCm()

const MAX_BYTES = 500 * 1024

const props = defineProps({
  blobUrl:  { type: String, default: null },
  ext:      { type: String, default: null },
  fontSize: { type: Number, default: 13 },
  // 文件标识：滚动位置按它存进 localStorage，刷新（重载/组件重建）后据此还原
  fileKey:  { type: [String, Number], default: null },
  // 文件库预览时用于解析 Markdown 相对链接；聊天附件等非文件库内容不传此值。
  fileContext: { type: Object as PropType<Partial<FileMeta> | null>, default: null },
  // 虚拟文档（例如用户人格文件）不属于文件库，但复用同一套 Markdown 预览/编辑器。
  sourceText: { type: String, default: null },
  saveSource: { type: Function as PropType<(content: string) => Promise<void> | void>, default: null },
})

const router = useRouter()
const filesCache = useFilesCacheStore()
const previewStore = usePreviewStore()
const uiStore = useUiStore()

const tvScroll = ref<HTMLElement | null>(null)   // .tv-scroll 滚动容器
const mdRoot = ref<HTMLElement | null>(null)
let mermaidApi: typeof import('mermaid').default | null = null
let mermaidRenderSequence = 0
let themeObserver: MutationObserver | null = null

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

// highlight.js 按需注册的语言
const LANG_LOADERS: Record<string, () => Promise<any>> = {
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

// 扩展名 → CodeMirror 语言扩展的按需 loader（编辑用，跟 highlight.js 的语言加载器是两套独立映射：
// CM6 按语言拆成独立小包，命名和覆盖范围跟 highlight.js 不是一一对应，且 CM6 官方包覆盖了 hljs 这边
// 没接的 java/go/rust/cpp/sql，编辑时能比只读预览多几种语言的高亮）。没在这张表里的扩展名
// （csv/log/toml/ini/conf/env/tex）用 CodeMirror 编辑但不高亮，比之前退回纯 textarea 依然要好
// （撤销栈、多光标、大文件不卡这些能力还在，只是没有配色）。
const CM_LANG_LOADERS: Record<string, (source?: string) => Promise<any>> = {
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
  MD:   async (source = '') => {
    const [{ markdown }, { LanguageDescription, LanguageSupport, StreamLanguage }] = await Promise.all([
      import('@codemirror/lang-markdown'),
      import('@codemirror/language'),
    ])
    const language = (name: string, alias: string[], load: () => Promise<any>) =>
      LanguageDescription.of({ name, alias, load })
    const codeLanguages = [
      language('javascript', ['js', 'jsx'], () => import('@codemirror/lang-javascript').then(m => m.javascript())),
      language('typescript', ['ts', 'tsx'], () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true }))),
      language('python', ['py'], () => import('@codemirror/lang-python').then(m => m.python())),
      language('json', [], () => import('@codemirror/lang-json').then(m => m.json())),
      language('css', [], () => import('@codemirror/lang-css').then(m => m.css())),
      language('html', ['xml'], () => import('@codemirror/lang-html').then(m => m.html())),
      language('yaml', ['yml'], () => import('@codemirror/lang-yaml').then(m => m.yaml())),
      language('sql', [], () => import('@codemirror/lang-sql').then(m => m.sql())),
      language('shell', ['bash', 'sh'], () => import('@codemirror/legacy-modes/mode/shell')
        .then(({ shell }) => new LanguageSupport(StreamLanguage.define(shell)))),
    ]
    const fencedNames = [...source.matchAll(/```\s*([\w+#-]+)/g)].map(match => match[1].toLowerCase())
    await Promise.all(codeLanguages
      .filter(description => fencedNames.some(name => description.alias.includes(name) || description.name === name))
      .map(description => description.load()))
    return markdown({ codeLanguages })
  },
}

const mdHtml      = ref<string | null>(null)
const rawText     = ref('')   // 源文本（md 勾选任务框改写 [ ]↔[x]、md 编辑模式的保存基于这个）
// 真实文件（纯数字 id）才能存——聊天附件是 16 位 hex，PUT /files/{id}/content 存不了。
// 虚拟文档通过 saveSource 保存，不需要文件库 id。
const isRealFile = computed(() => /^\d+$/.test(String(props.fileKey ?? '')))
const isVirtualDocument = computed(() => props.sourceText !== null && !!props.saveSource)
const isEditableDocument = computed(() => isRealFile.value || isVirtualDocument.value)
// 可交互勾选 = md 文件 + 真实文件
const savable  = computed(() => /^(md|markdown)$/i.test(props.ext || '') && isRealFile.value)
// 可编辑 = 后端认得的文本类扩展名 + 真实文件（md 走「编辑」按钮切换态用得到；txt/代码类扩展名
// 不看这个——它们不管是不是真实文件都直接显示 CodeMirror，只是能不能保存的区别，见 isCodeExt）
const editable = computed(() => EDITABLE_EXTS.has((props.ext || '').toLowerCase()) && isEditableDocument.value)
const isMarkdownFile = computed(() => /^(md|markdown)$/i.test(props.ext || ''))
// 代码/纯文本扩展名（txt 并入 CodeMirror 路径，见 2026-09-03：txt 没有预览价值，还顺带拿到
// 行号、撤销栈和自动保存）：不分真实文件/聊天附件、不分编辑/预览，一律直接显示 CodeMirror。
// 只有 md 保留「渲染预览 + 编辑」双视图——渲染后的排版本身就是预览价值。
const isCodeExt = computed(() => {
  const e = (props.ext || '').toLowerCase()
  return EDITABLE_EXTS.has(e) && !isMarkdownFile.value
})
const loading     = ref(false)
const error       = ref<string | null>(null)
const truncated   = ref(false)

// ── 编辑模式：仅 md 有「渲染预览 + 编辑」切换态；txt/代码类见 isCodeExt（没有切换态） ──
const editing   = ref(false)
const mdEditorReady = ref(false)
const editText  = ref('')
const saving    = ref(false)
const saveError = ref('')

const cmView       = ref<any>(null)   // 当前 CodeMirror 的 EditorView 实例（@ready 拿到；EditorView 动态导入，标 any）
const cmExtensions = ref<any[]>([])     // 基础扩展 + 按需加载的语言扩展（CM6 扩展类型复杂，标 any）
let cmLoadSeq = 0

// vue-codemirror 的 <Codemirror> 组件内部本来就默认带了一份 basicSetup（含行号+代码折叠两个
// gutter），跟组件本身无关、不受 :extensions 传参影响；不要自己再传 basicSetup（或任何行号类
// 扩展），只在 :extensions 里加主题和语法高亮配色，行号/折叠/撤销栈交给组件内置的那份就够。
async function ensureCm() {
  if (!CM) {
    const [{ EditorView, keymap }, { syntaxHighlighting }, { classHighlighter }] = await Promise.all([
      import('@codemirror/view'),
      import('@codemirror/language'),
      import('@lezer/highlight'),
    ])
    // 不能设为 fallback：vue-codemirror 的 basicSetup 自带默认高亮，fallback 会让它压过 tok-* 配色。
    CM = { EditorView, keymap, highlighting: syntaxHighlighting(classHighlighter) }
  }
  return CM
}

async function loadCmExtensions(ext: string, source = '') {
  const cm = await ensureCm()
  const { acceptCompletion } = await import('@codemirror/autocomplete')
  const theme = cm.EditorView.theme({
    '&': { height: '100%', fontSize: 'var(--tv-font-size, 13px)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
      fontFamily: "var(--font-family-mono)",
      textDecoration: 'none', whiteSpace: 'pre-wrap',
    },
    '.cm-line, .cm-line *': { textDecoration: 'none !important', whiteSpace: 'pre-wrap' },
    '.cm-scroller': { overflow: 'auto' },
    // 组件内置的 basicSetup 除了行号还带一个代码折叠 gutter，用不上，隐藏掉不留预留空白
    '.cm-foldGutter': { display: 'none' },
  })
  const loader = CM_LANG_LOADERS[(ext || '').toUpperCase()]
  const langExt = loader ? await loader(source) : null
  cmExtensions.value = [theme, cm.EditorView.lineWrapping, cm.highlighting, ...(langExt ? [langExt] : []),
    // 补全菜单打开时 Tab 接受当前项；没有补全时由 CodeMirror 默认缩进处理。
    cm.keymap.of([{ key: 'Tab', run: acceptCompletion }]),
  ]
}
function onCmReady({ view }: { view: any }) {
  cmView.value = view
}

// 代码文件自动保存（防抖，改一下等 800ms 没有新改动再存，不是敲一个字符存一次）。fileKey/待存
// 内容在「排队时」（每次改动都会重新排一次）就地闭包捕获，不是等定时器触发才现读——就算这中间
// 文件被切走（props.fileKey/editText 已经变成新文件的），排队中的这次还是会把旧文件的旧内容存
// 到旧文件自己的 id 上，不会存错文件。没有保存中/已保存的 UI 提示；失败了只打 console，不打扰
// 编辑——真要盯保存状态可以开 devtools 看。
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleAutoSave() {
  if (!isEditableDocument.value || !isRealFile.value) return
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  const targetKey = props.fileKey
  const content   = editText.value
  autoSaveTimer = setTimeout(() => { autoSaveTimer = null; doAutoSave(targetKey, content) }, 800)
}
async function doAutoSave(targetKey: string | number, content: string) {
  try {
    await filesApi.saveContent(Number(targetKey), content)
    rawText.value = content
  } catch (e) {
    console.error('[TextViewer] 自动保存失败:', e)  // eslint
  }
}

// md 的预览/编辑双视图是两套独立 DOM，进出编辑态要把滚动位置对上：md 渲染成 HTML 后跟源码
// 行号没有线性对应关系（标题/段落/代码块各自高度不同），只能按滚动比例（scrollTop / 可滚动
// 距离）估算。
let scrollFrac = 0

function captureScroll(el: HTMLElement | null) {
  if (!isMarkdownFile.value || !el) return
  const max = el.scrollHeight - el.clientHeight
  scrollFrac = max > 0 ? el.scrollTop / max : 0
}
function applyScroll(el: HTMLElement | null) {
  if (!el || !isMarkdownFile.value) return
  const max = el.scrollHeight - el.clientHeight
  el.scrollTop = max > 0 ? scrollFrac * max : 0
}

async function startEdit() {
  captureScroll(tvScroll.value)
  editText.value = rawText.value
  saveError.value = ''
  cmView.value = null
  mdEditorReady.value = false
  const loadSeq = ++cmLoadSeq
  editing.value = true
  await loadCmExtensions('MD', editText.value)
  if (loadSeq !== cmLoadSeq || !editing.value) return
  mdEditorReady.value = true
  await nextTick()
  cmView.value?.focus()
}
function cancelEdit() {
  captureScroll(tvScroll.value)
  cmLoadSeq++
  cmView.value = null
  mdEditorReady.value = false
  editing.value = false
  nextTick(() => applyScroll(tvScroll.value))
}
async function saveEdit() {
  saving.value = true
  saveError.value = ''
  try {
    captureScroll(tvScroll.value)
    if (isVirtualDocument.value) {
      await props.saveSource?.(editText.value)
    } else {
      await filesApi.saveContent(Number(props.fileKey), editText.value)
    }
    await processText(editText.value, props.ext)
    cmLoadSeq++
    mdEditorReady.value = false
    cmView.value = null
    editing.value = false
    await nextTick()
    applyScroll(tvScroll.value)
  } catch (e) {
    saveError.value = '保存失败：' + ((e instanceof Error ? e.message : '') || '未知错误')
  } finally {
    saving.value = false
  }
}

let hljs: any = null   // highlight.js 句柄，动态导入

// ── HTML 转义 ────────────────────────────────────────
function escHtml(s: string) {
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
let _tvMarked: any = null   // 独立 marked 实例，动态导入

async function renderMarkdown(text: string) {
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
          if (String(lang || '').trim().toLowerCase() === 'mermaid') {
            return `<pre class="md-mermaid-source"><code>${escHtml(text)}</code></pre>`
          }
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

  return sanitizeHtml(_tvMarked.parse(text) as string)
}

function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme === 'dark'
}

function cssToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

async function getMermaid() {
  if (!mermaidApi) mermaidApi = (await import('mermaid')).default
  return mermaidApi
}

function configureMermaid(mermaid: NonNullable<typeof mermaidApi>): void {
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
  const sequence = ++mermaidRenderSequence
  element.dataset.renderSequence = String(sequence)
  try {
    const mermaid = await getMermaid()
    configureMermaid(mermaid)
    const { svg } = await mermaid.render(`tv-mermaid-${sequence}`, source)
    if (!element.isConnected || element.dataset.renderSequence !== String(sequence)) return
    const cleanSvg = sanitizeHtml(svg)
    element.innerHTML = cleanSvg
    bindMermaidInteractions(element)
    element.classList.add('md-mermaid-ready')
    element.classList.remove('md-mermaid-error')
  } catch {
    element.classList.add('md-mermaid-error')
    element.textContent = `Mermaid 图表渲染失败\n\n${source}`
  }
}

async function renderMermaidBlocks(): Promise<void> {
  await nextTick()
  if (!mdRoot.value) return
  const sourceBlocks = Array.from(mdRoot.value.querySelectorAll<HTMLElement>('.md-mermaid-source'))
  for (const sourceBlock of sourceBlocks) {
    const source = sourceBlock.textContent || ''
    const container = document.createElement('div')
    container.className = 'md-mermaid'
    container.dataset.source = encodeURIComponent(source)
    sourceBlock.replaceWith(container)
  }
  for (const container of mdRoot.value.querySelectorAll<HTMLElement>('.md-mermaid')) {
    const encoded = container.dataset.source
    if (encoded) await renderMermaidBlock(container, decodeURIComponent(encoded))
  }
}

// ── 任务勾选框可交互：去掉 marked 默认的 disabled、按文档顺序标 data-task（仅 md + 真实文件）──
function makeTasksInteractive(html: string) {
  if (!savable.value) return html
  let i = 0
  return html.replace(/<input\b[^>]*?type="checkbox"[^>]*?>/gi, (tag) =>
    tag.replace(/\sdisabled(="[^"]*")?/i, '').replace(/^<input/i, `<input data-task="${i++}"`)
  )
}

const _TASK_RE = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/
// 勾第 idx 个任务（文档顺序）：按勾选框的新状态翻转源里对应行 [ ]↔[x]、回存文件；存失败回滚视觉
async function toggleTask(idx: number, cb: HTMLInputElement) {
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

// ── md 区域点击（事件委托）：任务勾选框/复制按钮/文件库相对链接 ──
async function onMdClick(e: MouseEvent) {
  const cb = (e.target as HTMLElement).closest('input[type="checkbox"][data-task]') as HTMLInputElement | null
  if (cb) { toggleTask(Number(cb.dataset.task), cb); return }   // 不 preventDefault：原生勾选即时显示
  const btn = (e.target as HTMLElement).closest('.md-copy-btn') as HTMLElement | null
  if (btn) {
    const code = btn.closest('.md-pre')?.querySelector('code')?.textContent ?? ''
    navigator.clipboard.writeText(code).then(() => {
      btn.classList.add('md-copied')
      setTimeout(() => btn.classList.remove('md-copied'), 2000)
    })
    return
  }

  const anchor = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
  if (!anchor || !props.fileContext?.id) return
  const href = anchor.getAttribute('href')
  if (!href) return
  if (!filesCache.loaded) await filesCache.load()
  const resolved = resolveRelativeFileLink(
    href,
    { folderId: props.fileContext.folderId, projectId: props.fileContext.projectId },
    filesCache.allFiles,
    filesCache.allFolders,
  )
  if (!resolved) return

  e.preventDefault()
  if (resolved.kind === 'file' && isPreviewable(resolved.file.ext)) {
    previewStore.open(resolved.file)
    return
  }
  uiStore.pendingFileTarget = { kind: resolved.kind, id: resolved.kind === 'file' ? resolved.file.id : resolved.folder.id }
  await router.push('/files')
}

// 把一段文本渲染成 mdHtml（首次加载、md 编辑保存后重渲都走这条）。txt/代码类扩展名不在这里
// 处理——它们直接显示 CodeMirror，没有只读渲染，见 isCodeExt。
async function processText(text: string, ext: string) {
  mdHtml.value  = null
  rawText.value = text
  if ((ext || '').toUpperCase() === 'MD') {
    mdHtml.value = makeTasksInteractive(await renderMarkdown(text))
    await renderMermaidBlocks()
  }
}

watch(() => [props.blobUrl, props.ext, props.sourceText], async ([url, ext, sourceText]) => {
  if (!url && sourceText === null) return
  loading.value   = true
  error.value     = null
  truncated.value = false
  editing.value   = false   // 切换文件/重新加载时退出编辑态，别把上一份文件的编辑框留着
  cmLoadSeq++
  mdEditorReady.value = false
  cmView.value    = null
  saveError.value = ''

  try {
    let text: string
    if (sourceText !== null) {
      text = sourceText
      truncated.value = new TextEncoder().encode(text).byteLength > MAX_BYTES
    } else {
      const res  = await fetch(url as string)
      const buf  = await res.arrayBuffer()
      truncated.value = buf.byteLength > MAX_BYTES
      const slice = truncated.value ? buf.slice(0, MAX_BYTES) : buf
      text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    }
    await processText(text, ext)
    if (isCodeExt.value) {
      // 代码类扩展名没有单独的只读渲染，CodeMirror 直接从 editText 显示——加载完就把内容和
      // 对应语言扩展准备好，不用等用户点什么「编辑」
      editText.value = text
      await loadCmExtensions(ext)
    }
  } catch (e) {
    error.value = '读取失败：' + (e instanceof Error ? e.message : e)
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

onMounted(() => {
  // 首次文件加载可能发生在组件挂载前，此时 mdRoot 尚未存在；挂载后补一次 Mermaid 渲染。
  renderMermaidBlocks()
  themeObserver = new MutationObserver(() => renderMermaidBlocks())
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-family'] })
})

// 文件加载期间 .tv-scroll 被 loading 分支暂时移出 DOM；等预览节点真正出现后再渲染图表。
watch([mdHtml, loading], ([html, isLoading]) => {
  if (html && !isLoading) renderMermaidBlocks()
}, { flush: 'post' })

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  themeObserver = null
  cleanupMermaidInteractions(mdRoot.value)
  mermaidRenderSequence += 1
})
</script>

<style scoped>
.tv-wrap {
  position: absolute;
  inset: 0;
  background: var(--surface-card-solid, #fff);
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
  -webkit-user-select: text;
}

.tv-notice {
  font-size: 11px;
  color: var(--status-warning);
  background: var(--status-warning-bg);
  border-bottom: 1px solid color-mix(in srgb, var(--status-warning) 28%, transparent);
  padding: 6px 20px;
  margin-bottom: 8px;
}

/* ── 编辑入口（浮在只读视图右上角） ── */
.tv-edit-toggle {
  position: absolute; top: 10px; right: 14px; z-index: 2;
  width: 26px; height: 26px; border-radius: 7px;
  border: 1px solid var(--border-subtle); background: var(--action-soft); color: var(--action-primary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition:
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard),
    color var(--motion-hover-control) var(--motion-ease-standard);
}
.tv-edit-toggle:hover { background: var(--action-soft-hover); border-color: var(--action-outline); color: var(--action-primary-hover); }

/* ── md 编辑模式底部操作条 ── */
.tv-edit-bar {
  flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--border-default); background: var(--surface-raised);
}
.tv-edit-error { flex: 1; font-size: 12px; color: var(--status-danger); }
.tv-edit-btn {
  padding: 6px 16px; border-radius: 8px; font-size: 12px; font-weight: 600;
  border: 1px solid var(--border-default); background: var(--surface-card-solid); color: var(--content-secondary);
  cursor: pointer; transition: background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
}
.tv-edit-btn:hover:not(:disabled) { background: var(--surface-soft-hover); color: var(--content-primary); }
.tv-edit-btn:disabled { opacity: 0.5; cursor: default; }
.tv-edit-save {
  border-color: transparent; color: var(--content-on-accent);
  background: var(--action-primary-bg);
}
.tv-edit-save:hover:not(:disabled) { opacity: 1; background: var(--action-primary-bg-hover); }

/* ── 代码文件编辑：CodeMirror（字体/字号走 theme 里的 --tv-font-size，容器负责撑满高度） ── */
.tv-edit-cm-wrap { flex: 1; overflow: hidden; }
.tv-edit-cm-wrap :deep(.cm-editor) { height: 100%; background: var(--surface-card-solid); color: var(--content-primary); }
.tv-edit-cm-wrap :deep(.cm-scroller),
.tv-edit-cm-wrap :deep(.cm-content) { background: var(--surface-card-solid); color: var(--content-primary); }
/* 行号槽令牌化：CodeMirror 默认主题的 gutter 是亮色（白底灰字），暗色模式下是刺眼白条，
   必须在所有 CodeMirror 场景（代码文件 + Markdown 编辑）覆盖，不能只写在 md-wrap 上。 */
.tv-edit-cm-wrap :deep(.cm-gutters) {
  background: var(--surface-panel);
  border-right: 1px solid var(--border-subtle);
  color: var(--content-tertiary);
}
.tv-editor-loading {
  height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--content-secondary); font-size: 12px; background: var(--surface-card-solid);
}
.tv-edit-cm-wrap :deep(.cm-gutterElement) { color: var(--content-tertiary); }
/* CodeMirror 的活动行会单独给左侧行号加 cm-activeLineGutter，覆盖默认亮色主题。 */
.tv-edit-cm-wrap :deep(.cm-activeLine) {
  background: color-mix(in srgb, var(--action-primary) 5%, transparent);
}
.tv-edit-cm-wrap :deep(.cm-activeLineGutter) {
  background: var(--selection-bg);
  color: var(--content-primary);
}
.tv-edit-cm-wrap :deep(.cm-selectionBackground),
.tv-edit-cm-wrap :deep(.cm-focused .cm-selectionBackground) {
  /* Ctrl+D / Alt+拖拽产生的所有选区（主+副）都画成这个类，统一令牌色。
     浓度必须明显高于 activeLine 的 5%，否则选区和「当前行高亮」分不出。 */
  background: var(--selection-text-bg) !important;
}
/* 光标：CM 的明暗判定是 darkTheme 开关（我们没开，它默认亮色主题），
   亮色默认是黑边框光标，暗色模式下直接隐形，必须显式覆盖成正文色。 */
.tv-edit-cm-wrap :deep(.cm-cursor),
.tv-edit-cm-wrap :deep(.cm-dropCursor) {
  border-left-color: var(--content-primary);
}
.tv-edit-cm-wrap :deep(.cm-content) { caret-color: var(--content-primary); }
.tv-edit-cm-wrap :deep(.cm-content ::selection),
.tv-md ::selection {
  background: var(--selection-text-bg);
  color: var(--content-primary);
}
/* 选中一个词后其它相同词的匹配高亮（basicSetup 的 highlightSelectionMatches）：
   默认写死半透明绿 #99ff7780，与主题无关、暗色下跟选区色混在一起难以分辨。
   主匹配略浓、其余匹配略淡，都从主色派生以区分于普通选区。 */
.tv-edit-cm-wrap :deep(.cm-selectionMatch) {
  background: color-mix(in srgb, var(--action-primary) 22%, transparent);
}
.tv-edit-cm-wrap :deep(.cm-selectionMatch-main) {
  background: color-mix(in srgb, var(--action-primary) 45%, transparent);
}
/* CodeMirror 的 classHighlighter 使用稳定的 tok-* 类名，颜色贴近 VS Code Light。 */
.tv-edit-cm-wrap :deep(.tok-heading),
.tv-edit-cm-wrap :deep(.tok-heading1),
.tv-edit-cm-wrap :deep(.tok-heading2),
.tv-edit-cm-wrap :deep(.tok-heading3),
.tv-edit-cm-wrap :deep(.tok-heading4),
.tv-edit-cm-wrap :deep(.tok-heading5),
.tv-edit-cm-wrap :deep(.tok-heading6) { color: #6f62c4; font-weight: 700; }
.tv-edit-cm-wrap :deep(.tok-strong) { color: #8b5fc7; font-weight: 700; }
.tv-edit-cm-wrap :deep(.tok-emphasis) { color: #a56bb3; font-style: italic; }
/* 代码 token 与 GuguChat / MarkdownView 共用同一套配色。 */
.tv-edit-cm-wrap :deep(.tok-keyword),
.tv-edit-cm-wrap :deep(.tok-atom) { color: #7b5cf0; font-weight: 600; }
.tv-edit-cm-wrap :deep(.tok-string),
.tv-edit-cm-wrap :deep(.tok-string2) { color: #2d7a4f; }
.tv-edit-cm-wrap :deep(.tok-comment),
.tv-edit-cm-wrap :deep(.tok-quote),
.tv-edit-cm-wrap :deep(.tok-meta) { color: #9a9a9a; font-style: italic; }
.tv-edit-cm-wrap :deep(.tok-number),
.tv-edit-cm-wrap :deep(.tok-labelName),
.tv-edit-cm-wrap :deep(.tok-propertyName) { color: #b07858; }
.tv-edit-cm-wrap :deep(.tok-function),
.tv-edit-cm-wrap :deep(.tok-name),
.tv-edit-cm-wrap :deep(.tok-typeName),
.tv-edit-cm-wrap :deep(.tok-className) { color: #4a7fb5; font-weight: 600; }
.tv-edit-cm-wrap :deep(.tok-variableName),
.tv-edit-cm-wrap :deep(.tok-link),
.tv-edit-cm-wrap :deep(.tok-url) { color: #5a9e88; }

/* ── Markdown 渲染 ── */
.tv-md {
  padding: 32px 48px;
  max-width: 860px;
  margin: 0 auto;
  color: var(--content-primary, #24292f);
  font-size: var(--tv-font-size, 15px);
  line-height: 1.75;
  font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
}

.tv-md :deep(h1),
.tv-md :deep(h2),
.tv-md :deep(h3),
.tv-md :deep(h4) {
  font-weight: 600;
  margin: 1.5em 0 0.5em;
  line-height: 1.3;
  color: var(--content-primary, #1a1c24);
}
.tv-md :deep(h1) { font-size: 1.8em; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.3em; }
.tv-md :deep(h2) { font-size: 1.4em; border-bottom: 1px solid var(--border-hairline); padding-bottom: 0.25em; }
.tv-md :deep(h3) { font-size: 1.15em; }

.tv-md :deep(p)  { margin: 0.8em 0; }
.tv-md :deep(a)  { color: var(--action-primary); text-decoration: none; }
.tv-md :deep(a:hover) { text-decoration: underline; }

/* 行内代码 */
.tv-md :deep(code) {
  font-family: var(--font-family-mono);
  font-size: 0.875em;
  background: var(--action-soft);
  border-radius: 4px;
  padding: 0.15em 0.4em;
  color: var(--action-primary);
}

/* 代码块容器 */
.tv-md :deep(.md-pre) {
  position: relative;
  background: var(--surface-panel, #f0f1f6);
  border-radius: 10px;
  margin: 1em 0;
  overflow: hidden;
}
.tv-md :deep(.md-pre code) {
  display: block;
  padding: 14px 20px 16px;
  overflow-x: auto;
  background: none;
  color: var(--content-primary, #383a42);
  font-family: var(--font-family-mono);
  font-size: 13px;
  line-height: 1.65;
}

.tv-md :deep(.md-mermaid) {
  width: 100%; box-sizing: border-box; margin: 1em 0; padding: 12px;
  overflow-x: auto; border: 1px solid var(--border-default, rgba(42,35,49,.12));
  border-radius: 10px; background: var(--surface-card-solid, #fff); user-select: none;
}
.tv-md :deep(.md-mermaid svg) { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.tv-md :deep(.md-mermaid) { position: relative; cursor: default; touch-action: none; }
.tv-md :deep(.md-mermaid-dragging) { cursor: grabbing; }
.tv-md :deep(.md-mermaid-controls) {
  position: absolute; top: 8px; right: 8px; z-index: 1;
  display: flex; gap: 3px; padding: 3px;
  border: 1px solid var(--border-default); border-radius: 7px;
  background: var(--surface-card-solid); box-shadow: var(--elevation-card);
}
.tv-md :deep(.md-mermaid-controls button) {
  width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px;
  color: var(--content-secondary); background: transparent; cursor: pointer;
  font-size: 16px; line-height: 1;
}
.tv-md :deep(.md-mermaid-controls button:hover) { color: var(--content-primary); background: var(--surface-soft-hover); }
.tv-md :deep(.md-mermaid-error) {
  white-space: pre-wrap; color: var(--text-secondary, #67647a);
  font-family: var(--font-family-mono, monospace);
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
  color: var(--content-tertiary);
  font-family: var(--font-family-mono);
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
  color: var(--content-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px;
  transition: background var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
  opacity: 0;
}
.tv-md :deep(.md-pre:hover .md-copy-btn) { opacity: 1; }
.tv-md :deep(.md-copy-btn:hover) {
  background: var(--surface-soft-hover);
  color: var(--content-primary);
}
.tv-md :deep(.md-copy-btn svg) { width: 14px; height: 14px; }
.tv-md :deep(.md-check-icon) { display: none; }
.tv-md :deep(.md-copy-icon) { display: flex; }
.tv-md :deep(.md-copy-btn.md-copied) { color: var(--status-success); }
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
/* 外观（边框/选中态/勾）已收进全局 input[type="checkbox"] 样式（src/assets/styles/global.css），
   这里只留 markdown 场景特有的布局/交互覆盖：跟文字对齐、非任务勾选框禁用手型。 */
.tv-md :deep(input[type="checkbox"]) {
  flex-shrink: 0;
  position: relative;
  top: 2px;
  cursor: default;
}
/* 可交互勾选框（md + 真实文件）：手型 + hover 提示可点 */
.tv-md :deep(input[type="checkbox"][data-task]) { cursor: pointer; }
.tv-md :deep(input[type="checkbox"][data-task]:hover) { border-color: var(--action-outline); }

.tv-md :deep(blockquote) {
  margin: 1em 0;
  padding: 0 1em;
  border-left: 3px solid var(--action-outline);
  color: var(--content-secondary);
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
  border: 1px solid var(--border-document-table);
  text-align: left;
}
.tv-md :deep(th) { background: var(--surface-soft); font-weight: 600; }
.tv-md :deep(tr:hover td) { background: var(--surface-soft-hover); }

.tv-md :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-subtle);
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
  color: var(--content-secondary);
  font-size: 13px;
}
.tv-error { color: var(--status-danger); }
.tv-spinner {
  width: 24px; height: 24px; border-radius: 50%;
  border: 2px solid var(--action-soft);
  border-top-color: var(--action-primary);
  border-top-color: rgba(123, 127, 178, 0.7);
  animation: tv-spin 0.7s linear infinite;
}
@keyframes tv-spin { to { transform: rotate(360deg); } }
</style>
