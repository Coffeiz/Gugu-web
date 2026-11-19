import { z } from 'zod'
import { asciiDecimalDigits, isDecimalDigits } from '../shared/unicode-decimal.js'
import { strip } from '../shared/values.js'
import { physicalLines } from './note-read.js'

const referenceType = z.enum(['project', 'file', 'event'])
const mark = z.object({ type: z.enum(['bold', 'italic', 'strike', 'code', 'link']), href: z.string().optional() }).strict()
const inline = z.object({
  type: z.enum(['text', 'reference']), text: z.string().optional(), marks: z.array(mark).optional(),
  ref_type: referenceType.optional(), ref_id: z.number().int().safe().optional(), label: z.string().optional(),
}).strict()
const content = z.array(inline)
const item = z.object({ content, checked: z.boolean().optional() }).strict()
export const mindBlocksSchema = z.array(z.object({
  type: z.enum(['paragraph', 'heading', 'bullet_list', 'ordered_list', 'task_list', 'blockquote', 'code_block', 'horizontal_rule']),
  content: content.optional(), items: z.array(item).optional(), paragraphs: z.array(item).optional(),
  code: z.string().optional(), language: z.string().optional(),
}).strict())

export class MindNoteContentError extends Error {}
type Reference = { type: z.infer<typeof referenceType>; id: number }

function requireText(value: string | undefined, field: string): string {
  if (value === undefined) throw new MindNoteContentError(`${field} 必须是文本`)
  if (value.includes('\0')) throw new MindNoteContentError(`${field} 不能包含空字符`)
  return value
}

export function serializeMindBlocks(blocks: z.infer<typeof mindBlocksSchema>) {
  if (blocks.length > 200) throw new MindNoteContentError('单条笔记最多支持 200 个内容块')
  const references = new Map<string, Reference>()

  function renderInline(parts: z.infer<typeof content> = []): string {
    return parts.map(part => {
      if (part.type === 'reference') {
        const { ref_type, ref_id } = part
        const label = requireText(part.label, '引用显示名')
        if (!ref_type || !ref_id || ref_id < 1) throw new MindNoteContentError('引用必须指向已有的项目、文件或活动')
        if (/[\]|]/u.test(label)) throw new MindNoteContentError('引用显示名不能包含 ] 或 |')
        references.set(`${ref_type}:${ref_id}`, { type: ref_type, id: ref_id })
        return `[[${ref_type}:${ref_id}|${label}]]`
      }
      let text = requireText(part.text, '文本')
      const marks = part.marks ?? []
      const names = new Set(marks.map(value => value.type))
      if (names.size !== marks.length) throw new MindNoteContentError('同一种文字样式不能重复')
      if (names.has('code') && names.size > 1) throw new MindNoteContentError('行内代码不能与其他文字样式叠加')
      for (const { type, href } of marks) {
        if (type === 'link') {
          const link = strip(requireText(href, '链接地址'))
          if (!/^(https?|mailto):/iu.test(link)) throw new MindNoteContentError('链接只支持 http、https 或 mailto 协议')
          text = `[${text}](${link})`
        } else {
          if (type === 'code' && text.includes('`')) throw new MindNoteContentError('行内代码文本不能包含反引号')
          const marker = { bold: '**', italic: '*', strike: '~~', code: '`' }[type]
          text = marker + text + marker
        }
      }
      return text
    }).join('')
  }

  const markdown = blocks.map(block => {
    switch (block.type) {
      case 'paragraph': return renderInline(block.content)
      case 'heading': return '# ' + renderInline(block.content)
      case 'horizontal_rule': return '---'
      case 'code_block': {
        const code = requireText(block.code, '代码块内容')
        const language = block.language ?? ''
        if (/[\n`]/u.test(language)) throw new MindNoteContentError('代码块语言非法')
        if (code.includes('```')) throw new MindNoteContentError('代码块内容不能包含三个连续反引号')
        return '```' + language + '\n' + code + '\n```'
      }
      case 'blockquote':
        if (!block.paragraphs) throw new MindNoteContentError('引用块 paragraphs 必须是数组')
        return block.paragraphs.map(paragraph => '> ' + renderInline(paragraph.content)).join('\n')
      default: {
        const field = { bullet_list: '列表 items', ordered_list: '有序列表 items', task_list: '待办 items' }[block.type]
        if (!block.items) throw new MindNoteContentError(`${field} 必须是数组`)
        return block.items.map((line, index) => {
          if (block.type === 'task_list' && line.checked === undefined)
            throw new MindNoteContentError('待办项必须包含 checked 布尔值')
          const prefix = block.type === 'ordered_list' ? `${index + 1}. `
            : block.type === 'task_list' ? `- [${line.checked ? 'x' : ' '}] ` : '- '
          return prefix + renderInline(line.content)
        }).join('\n')
      }
    }
  }).join('\n\n')
  return { markdown, references: [...references.values()] }
}

export type MindLineEdit = { target_lines: string; content: string; expected?: string }
export function applyMindLineEdits(text: string, edits: readonly MindLineEdit[]): string {
  if (!edits.length) throw new MindNoteContentError('line_edits 不能为空')
  const lines = physicalLines(text)
  const parsed = edits.map(edit => {
    const all = strip(edit.target_lines).toLowerCase() === 'all'
    const parts = edit.target_lines.split(/[-,]/u).map(strip)
    if (!all && (parts.length > 2 || parts.some(part => !isDecimalDigits(part))))
      throw new MindNoteContentError('target_lines 格式无效，请使用 all、8、8-11 或 8,11')
    const start = all ? 1 : Number(asciiDecimalDigits(parts[0]!))
    const end = all ? lines.length : Number(asciiDecimalDigits(parts[1] ?? parts[0]!))
    if (!all && (start < 1 || end < start || end > lines.length))
      throw new MindNoteContentError(`target_lines 超出范围，当前正文共有 ${lines.length} 行`)
    if (!all && edit.expected === undefined)
      throw new MindNoteContentError('数字行编辑必须提供 expected 原文，请先读取最新正文并按原始物理行号定位')
    return { ...edit, start, end }
  }).sort((left, right) => right.start - left.start)

  const normalize = (value: string) => value.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
  for (const [index, edit] of parsed.entries()) {
    if (index && edit.end >= parsed[index - 1]!.start)
      throw new MindNoteContentError('line_edits 的目标行范围不能重叠')
    const before = lines.slice(edit.start - 1, edit.end).join('')
    if (edit.expected !== undefined && normalize(before) !== normalize(edit.expected))
      throw new MindNoteContentError(`target_lines ${edit.start}-${edit.end} 的原文校验失败：该范围与 expected 不一致。请重新调用 note_get，按 numbered_content 的物理行号定位（标题和空行均计入），并复制对应 Markdown 原文，不含行号前缀。`)
    const replacement = edit.content && /[\r\n]$/u.test(before) && !/[\r\n]$/u.test(edit.content)
      ? edit.content + '\n' : edit.content
    lines.splice(edit.start - 1, edit.end - edit.start + 1, replacement)
  }
  return lines.join('')
}

/** 对 Markdown 原文执行一次字面替换，重叠出现的匹配也算歧义。 */
export function replaceUniqueMindText(text: string, find: string, replacement: string): string {
  if (!find.length) throw new MindNoteContentError('find_replace.find 不能为空')
  const start = text.indexOf(find)
  if (start === -1) throw new MindNoteContentError('find_replace 未找到原文。请从最新 note_get.content_md 逐字复制，保留空格和换行。')
  if (text.indexOf(find, start + 1) !== -1)
    throw new MindNoteContentError('find_replace 匹配多处。请扩大 find 的原文范围，直到只匹配一处。')
  return text.slice(0, start) + replacement + text.slice(start + find.length)
}
