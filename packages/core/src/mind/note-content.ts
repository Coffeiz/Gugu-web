import { asciiDecimalDigits, isDecimalDigits } from '../shared/unicode-decimal.js'
import { strip } from '../shared/values.js'
import { physicalLines } from './note-read.js'

export class MindNoteContentError extends Error {}

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

/** 只转换正文中的应用链接，保留代码和转义示例。 */
export async function convertMindMarkdownLinks(
  markdown: string,
  resolve: (type: string, id: string) => Promise<void>,
  previous?: string,
): Promise<string> {
  const parts: string[] = []
  let cursor = 0
  const tokens = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*(?=\r?$)|(?![\s\S]))|(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\2(?!`)|(?<![!\\])\[([^\[\]\r\n]+)\]\(gugu:\/\/open-object\/(file|project|event)\/([A-Za-z0-9_-]+)\)/gmu
  const validated = new Set<string>()
  for (const match of markdown.matchAll(tokens)) {
    const [, , , label, type, id] = match
    if (!label || !type || !id || previous?.includes(match[0])) continue
    const key = `${type}:${id}`
    if (!validated.has(key)) {
      await resolve(type, id)
      validated.add(key)
    }
    parts.push(markdown.slice(cursor, match.index), `[[${key}|${label}]]`)
    cursor = match.index + match[0].length
  }
  parts.push(markdown.slice(cursor))
  return parts.join('')
}
