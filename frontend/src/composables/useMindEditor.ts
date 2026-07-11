/**
 * 便签块编辑器：TipTap 文档 ⇄ Markdown 的双向转换 + 编辑器扩展装配。
 *
 * **窄口径**（2026-07-10 定版，见 docs/product/思维面板/笔记页UI设计.md）：
 *   正文 / 标题（单级——薄卡片里多级标题没有意义）/ 待办 / 无序列表（平铺不嵌套）/ 对象引用
 * 不做图片块、`/` 菜单（`/` 已预留给呼唤咕咕）、表格、多级标题。
 * **加粗/斜体/删除线/行内代码/链接 2026-07-11 起支持**（行内标记，成本低、TipTap 原生
 * 支持，见「格式扩展」一节）：解析走简化版 Markdown（`**`/`*`/`~~`/`` ` ``/`[text](url)`），
 * 不认 `_..._` 下划线写法——笔记里下划线常见于 snake_case 变量名/文件名，会被误判成斜体。
 * **代码块/引用块/有序列表/分割线 2026-07-11 起支持**（块级元素，见「格式扩展」一节）：
 * 走「插入」二级菜单，不走 `/` 菜单（`/` 已预留给呼唤咕咕）。
 * **无 Markdown 输入规则**：行首打 `#`/`-` 不触发格式转换，格式只走工具栏
 * （NoteEditor 里 `enableInputRules: false`）。
 *
 * Markdown 是便签的**存储格式**（后端 content_md），不是用户要写的东西：
 * 页面永远所见即所得，序列化只发生在保存/加载这一层。
 * 解析时标题 level 显式 clamp 成单级（存量便签里的 `##` 编辑保存时被规整，不批量迁移）；
 * `- [ ]` 必须先于 `- ` 匹配，否则待办会被当成普通列表。
 *
 * 对象引用存成 `[[project:7|某项目]]`——type+id 是稳定锚点（业务对象改名/重名都不指错），
 * 竖线后的显示名只作展示，后端抽 content_plain 时会保留它，便签才能按名字被搜到。
 * UI 触发键是 `@`（原 `[[`，2026-07-10 改），只是触发键，写进存储的仍是 `[[...]]`。
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { Blockquote } from '@tiptap/extension-blockquote'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import ListItem from '@tiptap/extension-list-item'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { all, createLowlight } from 'lowlight'
import CodeBlockView from '@/views/Mind/components/CodeBlockView.vue'

// 代码块语法高亮：只读预览和编辑态**必须走同一个 lowlight 实例**（同一份语言注册表），
// 不能预览用完整版 highlight.js、编辑态用 lowlight 的精简集——两边"猜语言"的候选池
// 不一样，同一段代码会被猜成不同语言、上色对不上（踩过：预览把 print 猜成 stylus 的
// title token 变粗体，编辑态精简集猜成 bash 就没有）。用 all（跟完整版 highlight.js
// 注册的语言数一致，192 种）不用 common（只有 37 种）——猜得准一些，笔记/咕咕以后
// 写的代码块语言不挑食。
const lowlight = createLowlight(all)

/** 与后端 `app/core/mind.py` 的 REF_PATTERN 保持一致 */
export const MIND_REF_RE = /\[\[([a-z_]+):(\d+)\|([^\]]*)\]\]/

/** 引用 chip 的类型徽标文案，跟 NoteEditor.vue 补全下拉的 TYPE_LABEL 是同一套 */
export const MIND_REF_TYPE_LABEL: Record<string, string> = { project: '项目', file: '文件', event: '活动' }

/** TipTap 的 JSON 文档节点（只用到我们支持的这几种，不引 tiptap 的类型免得耦合） */
export interface MindDocNode {
  type?: string
  attrs?: Record<string, any>
  content?: MindDocNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, any> }[]
}

// ── 对象引用：行内原子节点，整体选中/删除，不可编辑内部 ──────────────────────
export const MindRef = Node.create({
  name: 'mindRef',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      refType: { default: 'project' },
      refId:   { default: 0 },
      label:   { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-mind-ref]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-mind-ref': '',
      'data-ref-type': node.attrs.refType,
      'data-ref-id': String(node.attrs.refId),
      class: 'mind-ref',
    }), ['span', { class: 'mind-ref-type' }, MIND_REF_TYPE_LABEL[node.attrs.refType] ?? node.attrs.refType], node.attrs.label]
  },
})

// ── 无序列表项：不用原生 <li> + list-style 圆点（宽度不可控、跟待办的 checkbox 对不齐
// 缩进），改成手绘的固定宽度圆点（.mind-dot，只读预览里也用这个类名），文字起点才能
// 跟待办项精确对上。内容模型不变，只换 renderHTML。 ──
export const BulletListItem = ListItem.extend({
  renderHTML({ HTMLAttributes }) {
    return ['li', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      ['span', { class: 'mind-dot' }, '•'],
      ['div', {}, 0],
    ]
  },
})

// ── 有序列表项：跟无序列表用不同的节点名（配 OrderedList 的 itemTypeName），不然会共用
// BulletListItem 的渲染、跳出来的是圆点不是数字。序号不在这里手算——JS 侧不知道自己在
// 父列表里排第几，交给 CSS counter 在 <ol> 上跑，跟待办 checkbox/无序圆点同一套固定宽度
// 对齐（见 mind-content.css），数字比圆点宽（两位数）时靠 min-width 不强行锁死。 ──
export const OrderedListItem = ListItem.extend({
  name: 'orderedListItem',
  renderHTML({ HTMLAttributes }) {
    return ['li', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), ['div', {}, 0]]
  },
})

// ── 代码块：换成 Vue NodeView（CodeBlockView.vue），在语法高亮之外加一行语言名标签——
// 光靠颜色猜不出自动识别到底生没生效，得有个文字提示（跟只读预览的 .np-code-lang 对应）。 ──
const MindCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return VueNodeViewRenderer(CodeBlockView)
  },
})

// ── 引用块：默认 schema 是 content:'block+'，工具栏的列表按钮在引用块里也能点、能塞进
// 列表节点——但 docToMarkdown 的引用块序列化只认段落子节点（多段落=多行 `>`，同待办/
// 列表「一项一行」模型），塞进列表会让 inlineToMd 拿到的是块级子节点而非行内节点，序列化
// 成空字符串，保存后引用块整个变空、再编辑也是空的。收窄成 paragraph+ 从 schema 层面
// 挡掉这类嵌套，而不是等序列化层再兜底。
const MindBlockquote = Blockquote.extend({ content: 'paragraph+' })

// ── 行内标记：加粗/斜体/删除线/行内代码/链接（2026-07-11 起支持，窄口径里成本最低的一档）──
// 简化版解析，不是完整 CommonMark：每次找「剩余文本里最早出现的一种标记」整体吃掉，命中
// 内部的文字不再递归找同类型嵌套。加粗/斜体/删除线三个可以互相叠加（同一段文字点两个按钮），
// TipTap/ProseMirror 按 schema 里的固定顺序排 marks 数组（bold < italic < strike，跟
// StarterKit 注册顺序一致，与用户点击的先后次序无关），序列化时按这个顺序嵌套包裹，
// 于是叠加组合总是落在固定几种字面量上（`***x***`/`~~**x**~~`/`~~*x*~~`/`~~***x***~~`）——
// 这里把这几种组合也认成对应的多个 marks，不然会被单个 pattern 半吃半剩、往返出乱码
// （踩过：加粗+斜体点完变成 *text*text2 这种，就是没认出组合定界符，把结尾多出的星号
// 当成了新的一段斜体定界符）。
export interface MarkToken { text: string; marks: { type: string; attrs?: Record<string, any> }[] }

const MARK_PATTERNS: { re: RegExp; marks: (m: RegExpExecArray) => { type: string; attrs?: Record<string, any> }[] }[] = [
  { re: /`([^\s`][^`]*)`/, marks: () => [{ type: 'code' }] },
  // 三个都叠加 / 两两叠加：定界符更长，必须排在单个 mark 的 pattern 前面尝试到，
  // 不然会被短定界符从中间断开半个（比如 ***x*** 会被 **x** 先吃掉，剩一头一尾两个裸星号）
  { re: /~~\*\*\*([^\s*~][^*~]*)\*\*\*~~/, marks: () => [{ type: 'bold' }, { type: 'italic' }, { type: 'strike' }] },
  { re: /~~\*\*([^\s*~][^*~]*)\*\*~~/, marks: () => [{ type: 'bold' }, { type: 'strike' }] },
  { re: /~~\*([^\s*~][^*~]*)\*~~/, marks: () => [{ type: 'italic' }, { type: 'strike' }] },
  { re: /\*\*\*([^\s*][^*]*)\*\*\*/, marks: () => [{ type: 'bold' }, { type: 'italic' }] },
  { re: /\*\*([^\s*][^*]*)\*\*/, marks: () => [{ type: 'bold' }] },
  { re: /~~([^\s~][^~]*)~~/, marks: () => [{ type: 'strike' }] },
  { re: /\*([^\s*][^*]*)\*/, marks: () => [{ type: 'italic' }] },
  { re: /\[([^\]]+)\]\(([^)\s]+)\)/, marks: m => [{ type: 'link', attrs: { href: m[2] } }] },
]

function tokenizeMarks(text: string): MarkToken[] {
  if (!text) return []
  let earliest: { index: number; length: number; inner: string; marks: { type: string; attrs?: any }[] } | null = null
  for (const p of MARK_PATTERNS) {
    const m = p.re.exec(text)
    if (m && (!earliest || m.index < earliest.index)) {
      earliest = { index: m.index, length: m[0].length, inner: m[1], marks: p.marks(m) }
    }
  }
  if (!earliest) return [{ text, marks: [] }]
  const out: MarkToken[] = []
  if (earliest.index > 0) out.push({ text: text.slice(0, earliest.index), marks: [] })
  out.push({ text: earliest.inner, marks: earliest.marks })
  out.push(...tokenizeMarks(text.slice(earliest.index + earliest.length)))
  return out
}

/** marks → Markdown 包裹符号，跟 tokenizeMarks 认的语法对应（序列化用） */
function wrapMd(text: string, marks?: { type: string; attrs?: Record<string, any> }[]): string {
  if (!marks?.length) return text
  let out = text
  for (const mk of marks) {
    if (mk.type === 'bold') out = `**${out}**`
    else if (mk.type === 'italic') out = `*${out}*`
    else if (mk.type === 'strike') out = `~~${out}~~`
    else if (mk.type === 'code') out = '`' + out + '`'
    else if (mk.type === 'link') out = `[${out}](${mk.attrs?.href ?? ''})`
  }
  return out
}

// ── 序列化：doc → Markdown ────────────────────────────────────────────────────

function inlineToMd(nodes: MindDocNode[] = []): string {
  return nodes.map(n => {
    if (n.type === 'mindRef') {
      const a = n.attrs ?? {}
      return `[[${a.refType}:${a.refId}|${a.label ?? ''}]]`
    }
    if (n.type === 'hardBreak') return '\n'
    return wrapMd(n.text ?? '', n.marks)
  }).join('')
}

export function docToMarkdown(doc: MindDocNode | null | undefined): string {
  let result = ''
  let firstReal = true
  // 空段落＝用户敲了额外的回车专门空一行，不算独立的块——先攒着数量，等碰到下一个真实块
  // （或者到文档结尾还没等到）时，一次性换算成该有的空行数：块间恒定 1 条空行（白送，
  // 不需要额外的空段落），从第 2 条起才需要真的存一个空段落，所以 N 个连续空段落 = 在
  // 白送的那条之外再叠 N 条 —— 结尾也按同一条规则算，不能因为"后面没有块了"就被吞掉
  // （最初的写法是拼进上一块字符串再整体 trim()，结尾的空段落全被 trim 吃掉了，白做）。
  let pendingBlank = 0
  for (const b of doc?.content ?? []) {
    if (b.type === 'paragraph' && !b.content?.length) { pendingBlank++; continue }

    let blockStr: string
    if (b.type === 'heading') {
      // 标题单级：不管 doc 里是什么 level，序列化一律单 '#'
      blockStr = '# ' + inlineToMd(b.content)
    } else if (b.type === 'taskList') {
      // 整个待办列表是一个块，条目之间只隔单换行
      blockStr = (b.content ?? []).map(item => {
        const box = item.attrs?.checked ? 'x' : ' '
        return `- [${box}] ${inlineToMd(item.content?.[0]?.content)}`
      }).join('\n')
    } else if (b.type === 'bulletList') {
      blockStr = (b.content ?? []).map(item =>
        `- ${inlineToMd(item.content?.[0]?.content)}`
      ).join('\n')
    } else if (b.type === 'orderedList') {
      // 序号不存进 markdown 的"意义"里，只是显示——重新读回来时永远从 1 从头编号，
      // 这里导出也按数组顺序重新算，不读 TipTap 的 start 属性（没做自定义起始序号的 UI）
      blockStr = (b.content ?? []).map((item, i) =>
        `${i + 1}. ${inlineToMd(item.content?.[0]?.content)}`
      ).join('\n')
    } else if (b.type === 'blockquote') {
      // 引用块内允许多段（连续几行都用 >），每段各自一行，中间不留空行——
      // 跟待办/列表"一项一行"是同一个模型，多段落之间没有"松/紧"区分（简化，不是完整 CommonMark）
      blockStr = (b.content ?? []).map(p => '> ' + inlineToMd(p.content)).join('\n')
    } else if (b.type === 'codeBlock') {
      // 代码块内容是纯文本（marks:''，TipTap 本身就禁止代码块内再套加粗斜体这些），
      // 原样吐出来，不走 inlineToMd/mindRef 解析——代码里的 [[ ]] 应该保持原样，不被认成引用
      const code = (b.content ?? []).map(n => n.text ?? '').join('')
      const lang = b.attrs?.language ?? ''
      blockStr = '```' + lang + '\n' + code + '\n```'
    } else if (b.type === 'horizontalRule') {
      blockStr = '---'
    } else {
      blockStr = inlineToMd(b.content)
    }

    if (!firstReal) result += '\n\n' + '\n'.repeat(pendingBlank)
    result += blockStr
    firstReal = false
    pendingBlank = 0   // 文档开头的空段落（前面还没有真实块）直接扔掉，不是"结尾"情形
  }
  // 结尾一串空段落：前面必然已经有真实块（否则上面早被当成开头扔掉了），
  // 同一条规则——白送 1 条 + 每个空段落再叠 1 条
  if (pendingBlank > 0 && result) result += '\n'.repeat(pendingBlank + 1)
  return result
}

// ── 反序列化：Markdown → doc ──────────────────────────────────────────────────

function toTextNode(tok: MarkToken): MindDocNode {
  const node: MindDocNode = { type: 'text', text: tok.text }
  if (tok.marks.length) node.marks = tok.marks
  return node
}

function mdInlineToNodes(text: string): MindDocNode[] {
  const nodes: MindDocNode[] = []
  const re = new RegExp(MIND_REF_RE.source, 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(...tokenizeMarks(text.slice(last, m.index)).map(toTextNode))
    nodes.push({ type: 'mindRef', attrs: { refType: m[1], refId: Number(m[2]), label: m[3] } })
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(...tokenizeMarks(text.slice(last)).map(toTextNode))
  return nodes
}

/** 空 content 的块要省略 content 字段，否则 TipTap 会因为「空数组」报 schema 错 */
function block(type: string, text: string, attrs?: Record<string, any>): MindDocNode {
  const content = mdInlineToNodes(text)
  const node: MindDocNode = { type }
  if (attrs) node.attrs = attrs
  if (content.length) node.content = content
  return node
}

export function markdownToDoc(md: string | null | undefined): MindDocNode {
  const content: MindDocNode[] = []
  let tasks: MindDocNode[] = []
  let bullets: MindDocNode[] = []
  let orders: MindDocNode[] = []
  let quotes: MindDocNode[] = []
  let blankRun = 0
  // 代码块围栏状态机：``` 之间一切原样照抄，空行/`#`/`-`/`>` 这些在代码里没有特殊含义，
  // 必须在「是不是空行」判断之前先检查，不然代码里的空行会被误当成分段信号。
  let inCode = false
  let codeLang = ''
  let codeLines: string[] = []

  const flushTasks = () => {
    if (tasks.length) { content.push({ type: 'taskList', content: tasks }); tasks = [] }
  }
  const flushBullets = () => {
    if (bullets.length) { content.push({ type: 'bulletList', content: bullets }); bullets = [] }
  }
  const flushOrders = () => {
    if (orders.length) { content.push({ type: 'orderedList', content: orders }); orders = [] }
  }
  const flushQuotes = () => {
    if (quotes.length) { content.push({ type: 'blockquote', content: quotes }); quotes = [] }
  }
  const flushGroups = () => { flushTasks(); flushBullets(); flushOrders(); flushQuotes() }
  // 连续 N 条空行：第 1 条只是常规的块间分隔（默认就有，不用真的存一个空段落），从第 2 条
  // 起，每多一条空行，多存一个空段落——对应 docToMarkdown 里追加 '\n' 那半边，两边对称
  // 才能来回不丢。文档开头的空行前面没有块可"隔开"，不生成空段落（guard: content.length）。
  const flushBlankRun = () => {
    if (content.length) for (let i = 1; i < blankRun; i++) content.push({ type: 'paragraph' })
    blankRun = 0
  }
  const pushCodeBlock = () => {
    const node: MindDocNode = { type: 'codeBlock' }
    if (codeLang) node.attrs = { language: codeLang }
    // 空代码块（比如插入后什么都没打）：codeLines 可能是 ['']（一条空行），join 出来是
    // 空字符串——检查的是数组长度不是字符串长度，之前这里漏了这一步，塞进去一个
    // { type:'text', text:'' } 的空文本节点。ProseMirror 的 schema 不允许零长度文本节点，
    // 编辑器拿到这份 JSON 会直接 setContent 失败，卡片进编辑态后什么都渲染不出来。
    const code = codeLines.join('\n')
    if (code) node.content = [{ type: 'text', text: code }]
    content.push(node)
    codeLines = []
  }

  for (const raw of (md ?? '').split('\n')) {
    if (inCode) {
      if (/^\s*```\s*$/.test(raw)) { flushGroups(); flushBlankRun(); pushCodeBlock(); inCode = false; continue }
      codeLines.push(raw)
      continue
    }

    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { flushGroups(); blankRun++; continue }
    flushBlankRun()

    const fence = /^\s*```(\S*)\s*$/.exec(line)
    if (fence) { flushGroups(); inCode = true; codeLang = fence[1] || ''; continue }

    // 顺序敏感：`- [ ] x` 必须先于 `- x` 匹配，否则待办会被吃成普通列表
    const task = /^\s*-\s\[([ xX])\]\s?(.*)$/.exec(line)
    if (task) {
      flushBullets(); flushOrders(); flushQuotes()
      const para = block('paragraph', task[2])
      tasks.push({ type: 'taskItem', attrs: { checked: task[1].toLowerCase() === 'x' }, content: [para] })
      continue
    }
    const bullet = /^\s*-\s+(.*)$/.exec(line)
    if (bullet) {
      flushTasks(); flushOrders(); flushQuotes()
      bullets.push({ type: 'listItem', content: [block('paragraph', bullet[1])] })
      continue
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ordered) {
      flushTasks(); flushBullets(); flushQuotes()
      orders.push({ type: 'orderedListItem', content: [block('paragraph', ordered[1])] })
      continue
    }
    // 引用块：连续几行都可以用 `>`，累进同一个块（跟待办/列表一项一行是同一个模型），
    // 不支持"松/紧"两种段落间距的区分（简化，不是完整 CommonMark）
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushTasks(); flushBullets(); flushOrders()
      quotes.push(block('paragraph', quote[1]))
      continue
    }
    flushGroups()

    // 分割线：三个以上同一种字符（连续无空格，不认 CommonMark 那种"- - -"带空格写法，
    // 那样会先被上面的无序列表正则吃掉）
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { content.push({ type: 'horizontalRule' }); continue }

    // 标题：不依赖 TipTap 对越界 level 的默认降级行为，解析时显式 clamp 成单级
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { content.push(block('heading', h[2], { level: 1 })); continue }

    content.push(block('paragraph', line))
  }
  if (inCode) pushCodeBlock()   // 文档以未闭合的代码围栏结尾，也把已攒的内容存下来，不能悄悄丢掉
  flushGroups()
  flushBlankRun()   // 文档以空行结尾（结尾多打了几个回车）也要算数，不能只处理中间的

  if (!content.length) content.push({ type: 'paragraph' })
  return { type: 'doc', content }
}

// ── 只读预览：时间流里一条便签一个 TipTap 实例太重，用轻量 HTML 渲染 ──────────

const _ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s: string) => s.replace(/[&<>"]/g, c => _ESC[c])

/** lowlight 返回的是 hast 语法树（root/element/text 节点），不是现成的 HTML 字符串——
 *  这里手写一个最小转换，只处理 highlight.js 语法高亮实际会产出的两种节点类型，不是
 *  通用 hast→HTML（省得为这一个用途多引一个 hast-util-to-html 依赖）。 */
function hastToHtml(node: any): string {
  if (node.type === 'text') return esc(node.value ?? '')
  const inner = (node.children ?? []).map(hastToHtml).join('')
  if (node.type === 'element') {
    const cls = (node.properties?.className ?? []).join(' ')
    return cls ? `<span class="${cls}">${inner}</span>` : inner
  }
  return inner   // root 或其它没见过的节点类型：只透传子节点
}

/** 代码块统一走这一个函数算语法树 + 最终显示的语言名，只读预览（pushCodeBlock）和编辑态
 *  的语言标签（CodeBlockView.vue）共用，不用各自重复调一遍 lowlight——没写语言时两边都
 *  要显示 highlightAuto 猜出来的语言名，不然自动识别猜没猜中、猜没猜都没法确认。
 *  .registered() 而不是 listLanguages().includes()：后者只列出规范名，"js"/"ts" 这类
 *  别名会被判成"不认识"、错着退化去 highlightAuto 瞎猜（真出过这个问题）。 */
function highlightCode(explicit: string | null | undefined, code: string): { tree: any; language: string } {
  const known = explicit && lowlight.registered(explicit)
  const tree = known ? lowlight.highlight(explicit, code) : lowlight.highlightAuto(code)
  const language = known ? explicit : ((tree.data as any)?.language ?? 'plaintext')
  return { tree, language }
}

/** 只要显示用的语言名（编辑态语言标签用，见 CodeBlockView.vue），不需要高亮出来的语法树。 */
export function resolveCodeLanguage(explicit: string | null | undefined, code: string): string {
  return highlightCode(explicit, code).language
}

/** 链接 href 白名单：只放行 http(s)/mailto/相对路径，挡掉 `javascript:` 等注入手段——
 *  便签内容将来可能来自咕咕/粘贴，不是 100% 可信输入，渲染层要有兜底。 */
function safeHref(href: string): string {
  const h = href.trim()
  if (/^(https?:|mailto:)/i.test(h)) return h
  if (!/^[a-z][a-z0-9+.-]*:/i.test(h)) return h   // 无 scheme（相对路径/#锚点）视为安全
  return '#'
}

/** marks → HTML 包裹标签（只读预览用），传入的文字必须已经过 esc() 转义 */
function wrapHtml(escapedText: string, marks: { type: string; attrs?: any }[]): string {
  let out = escapedText
  for (const mk of marks) {
    if (mk.type === 'bold') out = `<strong>${out}</strong>`
    else if (mk.type === 'italic') out = `<em>${out}</em>`
    else if (mk.type === 'strike') out = `<s>${out}</s>`
    else if (mk.type === 'code') out = `<code>${out}</code>`
    else if (mk.type === 'link') out = `<a href="${esc(safeHref(mk.attrs?.href ?? ''))}" target="_blank" rel="noopener noreferrer">${out}</a>`
  }
  return out
}

function marksToHtml(text: string): string {
  return tokenizeMarks(text).map(tok => tok.marks.length ? wrapHtml(esc(tok.text), tok.marks) : esc(tok.text)).join('')
}

/** 先转义再套模板：即便便签正文里写了 HTML，也只会被当文本显示，不会注入。 */
function inlineToHtml(text: string): string {
  const out: string[] = []
  const re = new RegExp(MIND_REF_RE.source, 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(marksToHtml(text.slice(last, m.index)))
    out.push(`<span class="mind-ref" data-ref-type="${m[1]}" data-ref-id="${m[2]}"><span class="mind-ref-type">${esc(MIND_REF_TYPE_LABEL[m[1]] ?? m[1])}</span>${esc(m[3])}</span>`)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(marksToHtml(text.slice(last)))
  return out.join('')
}

/** 卡片预览。待办 checkbox 带 data-task-idx（全文第几个待办）且可点——卡上直接勾完成，
 *  点击由 NoteCard 捕获后走 toggleTaskInMd + PATCH，不进编辑态。
 *  每个可点行（段落/标题/待办项/列表项）都带 data-line-unit——跟 markdownToDoc 按同样
 *  顺序、同样分类规则数的"第几个可点单元"对应，点哪行进编辑态就能把光标定到哪行后面
 *  （见 NoteEditor.vue 的 focusAtLineUnit）。 */
export function mdToPreviewHtml(md: string | null | undefined): string {
  const out: string[] = []
  let tasks: string[] = []
  let bullets: string[] = []
  let orders: string[] = []
  let quotes: string[] = []
  let taskIdx = 0
  let lineUnit = 0
  let blankRun = 0
  let inCode = false
  let codeLang = ''
  let codeLines: string[] = []

  const flushTasks = () => {
    if (tasks.length) { out.push(`<ul class="np-tasks">${tasks.join('')}</ul>`); tasks = [] }
  }
  const flushBullets = () => {
    if (bullets.length) { out.push(`<ul class="np-list">${bullets.join('')}</ul>`); bullets = [] }
  }
  const flushOrders = () => {
    if (orders.length) { out.push(`<ol class="np-ordered">${orders.join('')}</ol>`); orders = [] }
  }
  // 引用块每段各自一个 data-line-unit（跟 markdownToDoc 的多段落 blockquote 对应，
  // 点多行引用里的某一行能精确定位到那一行，不是整块只有一个可点目标）
  const flushQuotes = () => {
    if (quotes.length) { out.push(`<blockquote class="np-quote">${quotes.join('')}</blockquote>`); quotes = [] }
  }
  const flushGroups = () => { flushTasks(); flushBullets(); flushOrders(); flushQuotes() }
  // 跟 markdownToDoc 的 flushBlankRun 对称：连续 N 条空行，从第 2 条起每多一条渲染一个空段落
  // 占位，data-line-unit 照样递增——保持跟编辑态「点哪行进编辑态就定位到哪行」的计数一致。
  // 塞一个 &nbsp;（不是空 <p></p>）：编辑态里空段落是 TipTap 塞的 <br>，同样撑出一整行的
  // 行高；空 <p></p> 没有任何行内内容，行高不生效，会比编辑态矮一截，两边对不齐。
  const flushBlankRun = () => {
    if (out.length) for (let i = 1; i < blankRun; i++) out.push(`<p class="np-blank" data-line-unit="${lineUnit++}">&nbsp;</p>`)
    blankRun = 0
  }
  // 代码块整块只占一个 data-line-unit（内容是一整块纯文本，不按行拆开可点定位），
  // 跟 NoteEditor.vue focusAtLineUnit 的 LEAF_TYPES 把 codeBlock 当一个不下钻的叶子对应。
  // 语言标签头：没写语言时也要显示 highlightAuto 猜出来的语言名，不然用户不知道自动识别
  // 到底生没生效（见 highlightCode() 顶部注释）。
  const pushCodeBlock = () => {
    const code = codeLines.join('\n')
    const { tree, language } = highlightCode(codeLang, code)
    const highlighted = (tree.children ?? []).map(hastToHtml).join('')
    out.push(
      `<div class="np-code-block" data-line-unit="${lineUnit++}">` +
      `<div class="np-code-lang">${esc(language)}</div>` +
      `<pre class="np-code"><code class="hljs language-${esc(language)}">${highlighted}</code></pre>` +
      `</div>`,
    )
    codeLines = []
  }

  for (const raw of (md ?? '').split('\n')) {
    if (inCode) {
      if (/^\s*```\s*$/.test(raw)) { flushGroups(); flushBlankRun(); pushCodeBlock(); inCode = false; continue }
      codeLines.push(raw)
      continue
    }

    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { flushGroups(); blankRun++; continue }
    flushBlankRun()

    const fence = /^\s*```(\S*)\s*$/.exec(line)
    if (fence) { flushGroups(); inCode = true; codeLang = fence[1] || ''; continue }

    const task = /^\s*-\s\[([ xX])\]\s?(.*)$/.exec(line)
    if (task) {
      flushBullets(); flushOrders(); flushQuotes()
      const done = task[1].toLowerCase() === 'x'
      tasks.push(
        `<li class="${done ? 'done' : ''}" data-line-unit="${lineUnit++}">` +
        `<input type="checkbox" data-task-idx="${taskIdx++}"${done ? ' checked' : ''}>` +
        `<span>${inlineToHtml(task[2])}</span></li>`,
      )
      continue
    }
    const bullet = /^\s*-\s+(.*)$/.exec(line)
    if (bullet) {
      flushTasks(); flushOrders(); flushQuotes()
      // 跟待办同一套 flex+固定宽度标记结构（.mind-dot），文字起点才能跟 checkbox 后的文字对齐——
      // 原生 list-style 圆点宽度不可控，没法跟 checkbox 的宽度精确对上
      bullets.push(`<li data-line-unit="${lineUnit++}"><span class="mind-dot">•</span><span>${inlineToHtml(bullet[1])}</span></li>`)
      continue
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ordered) {
      flushTasks(); flushBullets(); flushQuotes()
      // 数字不在这里手算，交给 CSS counter（见 mind-content.css），JS 侧不用关心当前排第几
      orders.push(`<li data-line-unit="${lineUnit++}"><span>${inlineToHtml(ordered[1])}</span></li>`)
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushTasks(); flushBullets(); flushOrders()
      quotes.push(`<p data-line-unit="${lineUnit++}">${inlineToHtml(quote[1])}</p>`)
      continue
    }
    flushGroups()

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr class="np-hr">'); continue }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { out.push(`<h1 data-line-unit="${lineUnit++}">${inlineToHtml(h[2])}</h1>`); continue }

    out.push(`<p data-line-unit="${lineUnit++}">${inlineToHtml(line)}</p>`)
  }
  if (inCode) pushCodeBlock()
  flushGroups()
  flushBlankRun()   // 结尾多打的空行也要渲染出来，不能只处理中间的
  return out.join('')
}

/** 标题 + 正文拼回单串 markdown（NoteCard 编辑区/CaptureBar 共用，跟 NoteCard._split
 *  解析约定保持一致）：没标题就只存正文，不产生假的 `#` 行。 */
export function combineTitleBody(title: string, body: string): string {
  const t = title.trim()
  return t ? `# ${t}\n${body}` : body
}

/** 读取便签首个非空行的标题块；画布/卡片等只读视图共用，避免各自按不同规则拆标题。 */
export function splitMindTitleBody(markdown: string | null | undefined) {
  const md = markdown || ''
  const lines = md.split('\n')
  const titleIndex = lines.findIndex(line => line.trim())
  if (titleIndex < 0) return { titleRaw: '', body: '' }
  const titleLine = lines[titleIndex].trim()
  if (!/^#{1,6}\s+/.test(titleLine)) return { titleRaw: '', body: md }
  const titleRaw = titleLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1')
  return { titleRaw, body: lines.slice(titleIndex + 1).join('\n').replace(/^\n+/, '') }
}

/** 翻转正文里第 idx 个待办的勾选态，返回新 Markdown（找不到返回原文） */
export function toggleTaskInMd(md: string, idx: number): string {
  let count = 0
  return md.split('\n').map(line => {
    const m = /^(\s*-\s\[)([ xX])(\]\s?.*)$/.exec(line)
    if (!m) return line
    if (count++ !== idx) return line
    return m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3]
  }).join('\n')
}

// ── 编辑器扩展：把不要的块全关掉，只留窄口径这几种 ───────────────────────────
export function mindExtensions(placeholder = '写点什么…') {
  return [
    StarterKit.configure({
      // 窄口径：多级标题/表格/图片仍不开。加粗/斜体/删除线/行内代码/链接 2026-07-11 起开
      // （行内标记）；引用块/有序列表/分割线 2026-07-11 起开（块级元素，走「插入」二级
      // 菜单，见 NoteEditor.vue）。代码块单独关掉，用下面的 MindCodeBlock 换掉（要语法
      // 高亮 + 语言名标签，见 mind-content.css 和 CodeBlockView.vue）。
      codeBlock: false,
      blockquote: false,       // 用下面 MindBlockquote 换掉——收窄 schema，禁止嵌套列表
      underline: false,
      link: { openOnClick: false, autolink: false, defaultProtocol: 'https' },
      heading: { levels: [1] },
      listItem: false,        // 用下面 BulletListItem 的自定义渲染（手绘圆点，对齐待办缩进）
      orderedList: { itemTypeName: 'orderedListItem' },   // 数字跟圆点不能共用一个节点渲染
    }),
    MindCodeBlock.configure({ lowlight }),
    MindBlockquote,
    BulletListItem,
    OrderedListItem,
    TaskList,
    TaskItem.configure({ nested: false }),
    MindRef,
    Placeholder.configure({ placeholder }),
  ]
}
