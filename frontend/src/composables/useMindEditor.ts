/**
 * 便签块编辑器：TipTap 文档 ⇄ Markdown 的双向转换 + 编辑器扩展装配。
 *
 * **窄口径**（P1 只支持四种块，见 docs/product/思维面板/实现方案.md）：
 *   正文 / 标题 / 待办 / 对象引用
 * 不做图片块、`/` 菜单、`@咕咕`、表格、加粗斜体列表引用代码块——StarterKit 里那些统统关掉。
 *
 * Markdown 是便签的**存储格式**（后端 content_md），不是用户要写的东西：
 * 页面永远所见即所得，序列化只发生在保存/加载这一层。
 *
 * 对象引用存成 `[[project:7|某项目]]`——type+id 是稳定锚点（业务对象改名/重名都不指错），
 * 竖线后的显示名只作展示，后端抽 content_plain 时会保留它，便签才能按名字被搜到。
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
      const lvl = Math.min(3, Math.max(1, Number(b.attrs?.level ?? 1)))
      out.push('#'.repeat(lvl) + ' ' + inlineToMd(b.content))
    } else if (b.type === 'taskList') {
      // 整个待办列表是一个块，条目之间只隔单换行
      out.push((b.content ?? []).map(item => {
        const box = item.attrs?.checked ? 'x' : ' '
        return `- [${box}] ${inlineToMd(item.content?.[0]?.content)}`
      }).join('\n'))
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
  const flushTasks = () => {
    if (tasks.length) { content.push({ type: 'taskList', content: tasks }); tasks = [] }
  }

  for (const raw of (md ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { flushTasks(); continue }

    const task = /^\s*-\s\[([ xX])\]\s?(.*)$/.exec(line)
    if (task) {
      const para = block('paragraph', task[2])
      tasks.push({ type: 'taskItem', attrs: { checked: task[1].toLowerCase() === 'x' }, content: [para] })
      continue
    }
    flushTasks()

    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) { content.push(block('heading', h[2], { level: h[1].length })); continue }

    content.push(block('paragraph', line))
  }
  flushTasks()

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

export function mdToPreviewHtml(md: string | null | undefined): string {
  const out: string[] = []
  let tasks: string[] = []
  const flushTasks = () => {
    if (tasks.length) { out.push(`<ul class="np-tasks">${tasks.join('')}</ul>`); tasks = [] }
  }

  for (const raw of (md ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { flushTasks(); continue }

    const task = /^\s*-\s\[([ xX])\]\s?(.*)$/.exec(line)
    if (task) {
      const done = task[1].toLowerCase() === 'x'
      tasks.push(
        `<li class="${done ? 'done' : ''}">` +
        `<input type="checkbox" disabled${done ? ' checked' : ''}>` +
        `<span>${inlineToHtml(task[2])}</span></li>`,
      )
      continue
    }
    flushTasks()

    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) { out.push(`<h${h[1].length}>${inlineToHtml(h[2])}</h${h[1].length}>`); continue }

    out.push(`<p>${inlineToHtml(line)}</p>`)
  }
  flushTasks()
  return out.join('')
}

// ── 编辑器扩展：把不要的块全关掉，只留四种 ───────────────────────────────────
export function mindExtensions(placeholder = '写点什么…') {
  return [
    StarterKit.configure({
      // 窄口径：这些一律不开
      bold: false, italic: false, strike: false, code: false, codeBlock: false,
      blockquote: false, bulletList: false, orderedList: false, listItem: false,
      horizontalRule: false, link: false, underline: false,
      heading: { levels: [1, 2, 3] },
    }),
    TaskList,
    TaskItem.configure({ nested: false }),
    MindRef,
    Placeholder.configure({ placeholder }),
  ]
}
