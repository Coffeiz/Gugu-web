/**
 * 便签块编辑器：TipTap 文档 ⇄ Markdown 的双向转换 + 编辑器扩展装配。
 *
 * **窄口径**（2026-07-10 定版，见 docs/product/思维面板/记录页UI设计.md）：
 *   正文 / 标题（单级——薄卡片里多级标题没有意义）/ 待办 / 无序列表（平铺不嵌套）/ 对象引用
 * 不做图片块、`/` 菜单（`/` 已预留给呼唤咕咕）、表格、加粗斜体引用代码块。
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
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'

/** 与后端 `app/core/mind.py` 的 REF_PATTERN 保持一致 */
export const MIND_REF_RE = /\[\[([a-z_]+):(\d+)\|([^\]]*)\]\]/

/** TipTap 的 JSON 文档节点（只用到我们支持的这几种，不引 tiptap 的类型免得耦合） */
export interface MindDocNode {
  type?: string
  attrs?: Record<string, any>
  content?: MindDocNode[]
  text?: string
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
    }), node.attrs.label]
  },
})

// ── 序列化：doc → Markdown ────────────────────────────────────────────────────

function inlineToMd(nodes: MindDocNode[] = []): string {
  return nodes.map(n => {
    if (n.type === 'mindRef') {
      const a = n.attrs ?? {}
      return `[[${a.refType}:${a.refId}|${a.label ?? ''}]]`
    }
    if (n.type === 'hardBreak') return '\n'
    return n.text ?? ''
  }).join('')
}

export function docToMarkdown(doc: MindDocNode | null | undefined): string {
  const out: string[] = []
  for (const b of doc?.content ?? []) {
    if (b.type === 'heading') {
      // 标题单级：不管 doc 里是什么 level，序列化一律单 '#'
      out.push('# ' + inlineToMd(b.content))
    } else if (b.type === 'taskList') {
      // 整个待办列表是一个块，条目之间只隔单换行
      out.push((b.content ?? []).map(item => {
        const box = item.attrs?.checked ? 'x' : ' '
        return `- [${box}] ${inlineToMd(item.content?.[0]?.content)}`
      }).join('\n'))
    } else if (b.type === 'bulletList') {
      out.push((b.content ?? []).map(item =>
        `- ${inlineToMd(item.content?.[0]?.content)}`
      ).join('\n'))
    } else {
      out.push(inlineToMd(b.content))
    }
  }
  // 块间空行分隔；空段落会留下多余换行，压掉
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── 反序列化：Markdown → doc ──────────────────────────────────────────────────

function mdInlineToNodes(text: string): MindDocNode[] {
  const nodes: MindDocNode[] = []
  const re = new RegExp(MIND_REF_RE.source, 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) })
    nodes.push({ type: 'mindRef', attrs: { refType: m[1], refId: Number(m[2]), label: m[3] } })
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
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
  const flushTasks = () => {
    if (tasks.length) { content.push({ type: 'taskList', content: tasks }); tasks = [] }
  }
  const flushBullets = () => {
    if (bullets.length) { content.push({ type: 'bulletList', content: bullets }); bullets = [] }
  }

  for (const raw of (md ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { flushTasks(); flushBullets(); continue }

    // 顺序敏感：`- [ ] x` 必须先于 `- x` 匹配，否则待办会被吃成普通列表
    const task = /^\s*-\s\[([ xX])\]\s?(.*)$/.exec(line)
    if (task) {
      flushBullets()
      const para = block('paragraph', task[2])
      tasks.push({ type: 'taskItem', attrs: { checked: task[1].toLowerCase() === 'x' }, content: [para] })
      continue
    }
    const bullet = /^\s*-\s+(.*)$/.exec(line)
    if (bullet) {
      flushTasks()
      bullets.push({ type: 'listItem', content: [block('paragraph', bullet[1])] })
      continue
    }
    flushTasks()
    flushBullets()

    // 标题：不依赖 TipTap 对越界 level 的默认降级行为，解析时显式 clamp 成单级
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { content.push(block('heading', h[2], { level: 1 })); continue }

    content.push(block('paragraph', line))
  }
  flushTasks()
  flushBullets()

  if (!content.length) content.push({ type: 'paragraph' })
  return { type: 'doc', content }
}

// ── 只读预览：时间流里一条便签一个 TipTap 实例太重，用轻量 HTML 渲染 ──────────

const _ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s: string) => s.replace(/[&<>"]/g, c => _ESC[c])

/** 先转义再套模板：即便便签正文里写了 HTML，也只会被当文本显示，不会注入。 */
function inlineToHtml(text: string): string {
  return esc(text).replace(
    new RegExp(MIND_REF_RE.source, 'g'),
    (_all, refType, refId, label) =>
      `<span class="mind-ref" data-ref-type="${refType}" data-ref-id="${refId}">${label}</span>`,
  )
}

/** 卡片预览。待办 checkbox 带 data-task-idx（全文第几个待办）且可点——卡上直接勾完成，
 *  点击由 NoteCard 捕获后走 toggleTaskInMd + PATCH，不进编辑态。 */
export function mdToPreviewHtml(md: string | null | undefined): string {
  const out: string[] = []
  let tasks: string[] = []
  let bullets: string[] = []
  let taskIdx = 0
  const flushTasks = () => {
    if (tasks.length) { out.push(`<ul class="np-tasks">${tasks.join('')}</ul>`); tasks = [] }
  }
  const flushBullets = () => {
    if (bullets.length) { out.push(`<ul class="np-list">${bullets.join('')}</ul>`); bullets = [] }
  }

  for (const raw of (md ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { flushTasks(); flushBullets(); continue }

    const task = /^\s*-\s\[([ xX])\]\s?(.*)$/.exec(line)
    if (task) {
      flushBullets()
      const done = task[1].toLowerCase() === 'x'
      tasks.push(
        `<li class="${done ? 'done' : ''}">` +
        `<input type="checkbox" data-task-idx="${taskIdx++}"${done ? ' checked' : ''}>` +
        `<span>${inlineToHtml(task[2])}</span></li>`,
      )
      continue
    }
    const bullet = /^\s*-\s+(.*)$/.exec(line)
    if (bullet) {
      flushTasks()
      bullets.push(`<li>${inlineToHtml(bullet[1])}</li>`)
      continue
    }
    flushTasks()
    flushBullets()

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { out.push(`<h1>${inlineToHtml(h[2])}</h1>`); continue }

    out.push(`<p>${inlineToHtml(line)}</p>`)
  }
  flushTasks()
  flushBullets()
  return out.join('')
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
      // 窄口径：这些一律不开（列表 2026-07-10 起开无序、平铺）
      bold: false, italic: false, strike: false, code: false, codeBlock: false,
      blockquote: false, orderedList: false,
      horizontalRule: false, link: false, underline: false,
      heading: { levels: [1] },
    }),
    TaskList,
    TaskItem.configure({ nested: false }),
    MindRef,
    Placeholder.configure({ placeholder }),
  ]
}
