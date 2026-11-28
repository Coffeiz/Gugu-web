import * as mammoth from 'mammoth'
import { unzipSync } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { parseFragment } from 'parse5'
import * as XLSX from 'xlsx'

export const OFFICE_TEXT_MAX_BYTES = 30 * 1024 * 1024
export const OFFICE_TEXT_MAX_CHARS = 200_000
export const OFFICE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['docx', 'xlsx', 'xls', 'ods', 'pptx', 'odt', 'odp', 'rtf', 'pdf'])

const LEGACY_EXTENSIONS = new Set(['doc', 'ppt'])
const ROW_LIMIT = 5_000
const COL_LIMIT = 60
const SHAPE_LIMIT = 500
const PPTX_MAX_ZIP_ENTRIES = 10_000
const PPTX_MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
const PPTX_MAX_XML_BYTES = 8 * 1024 * 1024
const PPTX_MAX_COMPRESSION_RATIO = 100
const RTF_DESTINATIONS = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer'])

export class OfficeTextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfficeTextError'
  }
}

function truncateCodePoints(text: string, maximum: number): string {
  const characters: string[] = []
  for (const character of text) {
    if (characters.length >= maximum) break
    characters.push(character)
  }
  return characters.join('')
}

function cellText(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const iso = value.toISOString()
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
  }
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  return String(value)
}

function extractWorkbook(bytes: Uint8Array, extension: string): string {
  let workbook: XLSX.WorkBook
  if (extension === 'xlsx' || extension === 'ods') validateOfficeZipCentralDirectory(bytes)
  try {
    workbook = XLSX.read(bytes, { type: 'array', cellDates: extension === 'xlsx', dense: false })
  } catch {
    throw new OfficeTextError('Office 表格无法解析')
  }
  const parts: string[] = []
  for (const name of workbook.SheetNames) {
    parts.push(`## ${name}`)
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name]!, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
      range: { s: { r: 0, c: 0 }, e: { r: ROW_LIMIT - 1, c: COL_LIMIT - 1 } },
    })
    for (const row of rows) {
      const values = row.slice(0, COL_LIMIT).map(cellText)
      if (values.some(value => value !== '')) parts.push(values.join('\t'))
    }
  }
  return parts.join('\n')
}

type XmlNode = Record<string, unknown>

function children(node: unknown): unknown[] {
  if (Array.isArray(node)) return node
  return []
}

function elementValue(node: unknown, name: string): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
  return (node as XmlNode)[name]
}

function taggedElements(node: unknown, name: string, output: XmlNode[] = []): XmlNode[] {
  if (Array.isArray(node)) {
    for (const child of node) taggedElements(child, name, output)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as XmlNode)) {
      if (key === name) output.push(node as XmlNode)
      taggedElements(value, name, output)
    }
  }
  return output
}

function xmlAttribute(node: XmlNode, name: string): string | undefined {
  const attributes = node[':@']
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return undefined
  const value = (attributes as XmlNode)[`@_${name}`]
  return typeof value === 'string' ? value : undefined
}

function textValue(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(decodeXmlText(node))
  else if (Array.isArray(node)) for (const child of node) textValue(child, out)
  else if (node && typeof node === 'object') {
    const value = (node as XmlNode)['#text']
    if (typeof value === 'string') out.push(decodeXmlText(value))
    else for (const child of Object.values(node as XmlNode)) textValue(child, out)
  }
}

function decodeXmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/g, entity => {
    if (entity === '&amp;') return '&'
    if (entity === '&lt;') return '<'
    if (entity === '&gt;') return '>'
    if (entity === '&quot;') return '"'
    if (entity === '&apos;') return "'"
    const hexadecimal = /^&#x([\da-f]+);$/i.exec(entity)
    const decimal = /^&#(\d+);$/.exec(entity)
    const codePoint = hexadecimal ? Number.parseInt(hexadecimal[1]!, 16) : Number.parseInt(decimal![1]!, 10)
    return String.fromCodePoint(codePoint)
  })
}

function collectTexts(node: unknown, tag: string, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectTexts(child, tag, out)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as XmlNode)) {
      if (key === tag) textValue(value, out)
      else collectTexts(value, tag, out)
    }
  }
}

function parseXml(bytes: Uint8Array): unknown[] {
  if (bytes.byteLength > PPTX_MAX_XML_BYTES) throw new OfficeTextError('Office 幻灯片 XML 超过安全上限')
  let xml: string
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new OfficeTextError('Office 幻灯片 XML 编码无效') }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new OfficeTextError('Office 幻灯片 XML 不允许 DTD 或实体声明')
  try {
    if (XMLValidator.validate(xml) !== true) throw new Error('XML 文档结构无效')
    const predefined = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])
    for (const [, entity] of xml.matchAll(/&([^;\s<&]*);/g)) {
      if (predefined.has(entity!)) continue
      const hexadecimal = /^#x([\da-f]+)$/i.exec(entity!)
      const decimal = /^#(\d+)$/.exec(entity!)
      const codePoint = hexadecimal ? Number.parseInt(hexadecimal[1]!, 16)
        : decimal ? Number.parseInt(decimal[1]!, 10) : Number.NaN
      const validCodePoint = codePoint === 9 || codePoint === 10 || codePoint === 13
        || codePoint >= 0x20 && codePoint <= 0xd7ff || codePoint >= 0xe000 && codePoint <= 0xfffd
        || codePoint >= 0x10000 && codePoint <= 0x10ffff
      if (!Number.isSafeInteger(codePoint) || !validCodePoint) throw new Error('XML 实体无效')
    }
    const parser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      processEntities: false,
      trimValues: false,
      maxNestedTags: 128,
    })
    return parser.parse(xml) as unknown[]
  } catch {
    throw new OfficeTextError('Office 幻灯片无法解析')
  }
}

function validateOfficeZipCentralDirectory(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const min = Math.max(0, bytes.byteLength - 65_557)
  let end = -1
  for (let offset = bytes.byteLength - 22; offset >= min; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break }
  }
  if (end < 0) throw new OfficeTextError('Office 压缩包无法读取')
  const disk = view.getUint16(end + 4, true)
  const centralDisk = view.getUint16(end + 6, true)
  const count = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  let offset = view.getUint32(end + 16, true)
  if (disk || centralDisk || count > PPTX_MAX_ZIP_ENTRIES || offset + centralSize > end) {
    throw new OfficeTextError('Office 压缩包结构无效或超出安全上限')
  }
  let expandedBytes = 0
  const names = new Set<string>()
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new OfficeTextError('Office 压缩包目录无效')
    }
    const flags = view.getUint16(offset + 8, true)
    const compressed = view.getUint32(offset + 20, true)
    const expanded = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const recordLength = 46 + nameLength + extraLength + commentLength
    if (offset + recordLength > end || compressed === 0xffffffff || expanded === 0xffffffff || (flags & 1)) {
      throw new OfficeTextError('Office 压缩包条目无效或不受支持')
    }
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (names.has(name)) throw new OfficeTextError('Office 压缩包包含重复条目')
    names.add(name)
    if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) {
      throw new OfficeTextError('Office 压缩包包含不安全路径')
    }
    expandedBytes += expanded
    if (expandedBytes > PPTX_MAX_UNCOMPRESSED_BYTES) {
      throw new OfficeTextError('Office 解压内容超过安全上限')
    }
    if (expanded > 0 && (compressed === 0 || expanded / compressed > PPTX_MAX_COMPRESSION_RATIO)) {
      throw new OfficeTextError('Office 压缩比超过安全上限')
    }
    offset += recordLength
  }
}

function resolveZipTarget(base: string, target: string): string | null {
  if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.includes('\\')) return null
  const parts: string[] = []
  for (const part of `${target.startsWith('/') ? '' : `${base}/`}${target}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return null; parts.pop() }
    else parts.push(part)
  }
  return parts.join('/')
}

function presentationSlideOrder(archive: Record<string, Uint8Array>, fallback: string[]): string[] {
  const presentationBytes = archive['ppt/presentation.xml'], relationBytes = archive['ppt/_rels/presentation.xml.rels']
  if (!presentationBytes || !relationBytes) return fallback
  try {
    const relations = new Map(taggedElements(parseXml(relationBytes), 'Relationship').flatMap(relation => {
      const id = xmlAttribute(relation, 'Id'), target = xmlAttribute(relation, 'Target')
      const path = target ? resolveZipTarget('ppt', target) : null
      return id && path ? [[id, path] as const] : []
    }))
    const ordered = taggedElements(parseXml(presentationBytes), 'p:sldId').flatMap(slide => {
      const relationId = xmlAttribute(slide, 'r:id'), target = relationId ? relations.get(relationId) : undefined
      return target && fallback.includes(target) ? [target] : []
    })
    return ordered.length ? ordered : fallback
  } catch { return fallback }
}

function slideNotesPath(archive: Record<string, Uint8Array>, slidePath: string): string | null {
  const slash = slidePath.lastIndexOf('/'), directory = slash < 0 ? '' : slidePath.slice(0, slash)
  const file = slidePath.slice(slash + 1)
  const relationshipPath = `${directory}/_rels/${file}.rels`
  const relationshipBytes = archive[relationshipPath]
  if (relationshipBytes) {
    try {
      for (const relationship of taggedElements(parseXml(relationshipBytes), 'Relationship')) {
        if (!xmlAttribute(relationship, 'Type')?.endsWith('/notesSlide')) continue
        const target = xmlAttribute(relationship, 'Target')
        return target ? resolveZipTarget(directory, target) : null
      }
    } catch { return null }
  }
  const numeric = /slide(\d+)\.xml$/.exec(file)?.[1]
  return numeric ? `ppt/notesSlides/notesSlide${numeric}.xml` : null
}

function htmlText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const current = node as Record<string, unknown>
  if (current.nodeName === '#text') return typeof current.value === 'string' ? current.value : ''
  const children = Array.isArray(current.childNodes) ? current.childNodes : []
  const tag = typeof current.tagName === 'string' ? current.tagName : ''
  if (tag === 'tr') {
    const cells = children.filter(child => {
      if (!child || typeof child !== 'object') return false
      const cellTag = (child as Record<string, unknown>).tagName
      return cellTag === 'td' || cellTag === 'th'
    }).map(child => htmlText(child).trim())
    return `\n${cells.join('\t')}\n`
  }
  const text = children.map(htmlText).join('')
  if (tag === 'p' || tag === 'li') return `${text.trim()}\n`
  return text
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  try {
    validateOfficeZipCentralDirectory(bytes)
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })
    return htmlText(parseFragment(result.value)).replace(/\n{3,}/g, '\n\n').trim()
  } catch (error) {
    if (error instanceof OfficeTextError) throw error
    throw new OfficeTextError('DOCX 文档无法解析')
  }
}

function extractPptx(bytes: Uint8Array): string {
  let archive: Record<string, Uint8Array>
  try {
    validateOfficeZipCentralDirectory(bytes)
    archive = unzipSync(bytes, { filter: entry => entry.name === 'ppt/presentation.xml'
      || entry.name === 'ppt/_rels/presentation.xml.rels'
      || entry.name.startsWith('ppt/slides/') || entry.name.startsWith('ppt/notesSlides/') })
  } catch (error) {
    if (error instanceof OfficeTextError) throw error
    throw new OfficeTextError('Office 幻灯片压缩包无法读取')
  }
  const slideNames = presentationSlideOrder(archive, Object.keys(archive)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1])))
  const parts: string[] = []
  let shapeCount = 0
  for (let i = 0; i < slideNames.length; i++) {
    parts.push(`## 幻灯片 ${i + 1}`)
    const slide = parseXml(archive[slideNames[i]!]!)
    const shapes: Array<{ contents: unknown; tag: string }> = []
    const findShapes = (node: unknown): void => {
      for (const child of children(node)) {
        if (!child || typeof child !== 'object' || Array.isArray(child)) continue
        const shapeTag = ['p:sp', 'p:graphicFrame', 'p:pic', 'p:cxnSp', 'p:grpSp']
          .find(name => Array.isArray(elementValue(child, name)))
        const shape = shapeTag ? elementValue(child, shapeTag) : undefined
        if (shapeTag && Array.isArray(shape)) shapes.push({ contents: shape, tag: shapeTag })
        else for (const nested of Object.values(child as XmlNode)) if (Array.isArray(nested)) findShapes(nested)
      }
    }
    findShapes(slide)
    for (const { contents: shape, tag } of shapes) {
      shapeCount++
      if (shapeCount > SHAPE_LIMIT) return truncateCodePoints(parts.join('\n'), OFFICE_TEXT_MAX_CHARS)
      if (tag === 'p:sp') {
        const paragraphs = taggedElements(shape, 'a:p').map(paragraph => {
          const texts: string[] = []
          collectTexts(paragraph, 'a:t', texts)
          return texts.join('')
        })
        const text = paragraphs.join('\n').trim()
        if (text) parts.push(text)
      }
      for (const table of taggedElements(shape, 'a:tbl')) {
        for (const row of taggedElements(table, 'a:tr')) {
          const cells = taggedElements(row, 'a:tc').map(cell => {
            const cellParagraphs = taggedElements(cell, 'a:p').map(paragraph => {
              const texts: string[] = []
              collectTexts(paragraph, 'a:t', texts)
              return texts.join('')
            })
            return cellParagraphs.join('\n').trim()
          })
          if (cells.some(cell => cell !== '')) parts.push(cells.join('\t'))
        }
      }
    }
    const noteName = slideNotesPath(archive, slideNames[i]!)
    if (noteName && archive[noteName]) {
      const notes: string[] = []
      collectTexts(parseXml(archive[noteName]!), 'a:t', notes)
      const note = notes.join('').trim()
      if (note) parts.push(`[备注] ${note}`)
    }
  }
  return parts.join('\n')
}

function extractOdf(bytes: Uint8Array, extension: 'odt' | 'odp'): string {
  let archive: Record<string, Uint8Array>
  try {
    validateOfficeZipCentralDirectory(bytes)
    archive = unzipSync(bytes, { filter: entry => entry.name === 'content.xml' })
  } catch { throw new OfficeTextError('ODF 文档压缩包无法读取') }
  const content = archive['content.xml']
  if (!content) throw new OfficeTextError('ODF 文档缺少正文')
  const root = parseXml(content)
  const paragraphs = taggedElements(root, 'text:p').flatMap(paragraph => {
    const values: string[] = []
    textValue(paragraph, values)
    const text = values.join('').trim()
    return text ? [text] : []
  })
  if (extension === 'odp') return paragraphs.join('\n')
  return paragraphs.join('\n')
}

function decodeRtfHex(hex: string): string {
  const byte = Number.parseInt(hex, 16)
  return new TextDecoder('windows-1252').decode(Uint8Array.of(byte))
}

function extractRtf(bytes: Uint8Array): string {
  const source = new TextDecoder('latin1').decode(bytes)
  if (!source.startsWith('{\\rtf')) throw new OfficeTextError('RTF 文档结构无效')
  const states: Array<{ skip: boolean; unicodeFallback: number }> = [{ skip: false, unicodeFallback: 1 }]
  const output: string[] = []
  let outputLength = 0
  const append = (value: string) => {
    if (!value || outputLength >= OFFICE_TEXT_MAX_CHARS) return
    const bounded = [...value].slice(0, OFFICE_TEXT_MAX_CHARS - outputLength).join('')
    output.push(bounded)
    outputLength += [...bounded].length
  }
  let fallbackRemaining = 0
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    const state = states.at(-1)!
    if (character === '{') {
      if (states.length >= 1_000) throw new OfficeTextError('RTF 嵌套层级超过安全上限')
      states.push({ ...state })
      continue
    }
    if (character === '}') {
      if (states.length > 1) states.pop()
      continue
    }
    if (character !== '\\') {
      if (fallbackRemaining) { fallbackRemaining--; continue }
      if (!state.skip && character !== '\r' && character !== '\n') append(character)
      continue
    }
    const next = source[index + 1]
    if (!next) break
    if (next === '\\' || next === '{' || next === '}') {
      index++
      if (fallbackRemaining) fallbackRemaining--
      else if (!state.skip) append(next)
      continue
    }
    if (next === "'") {
      const hex = source.slice(index + 2, index + 4)
      if (/^[\da-f]{2}$/i.test(hex)) {
        index += 3
        if (fallbackRemaining) fallbackRemaining--
        else if (!state.skip) append(decodeRtfHex(hex))
      }
      continue
    }
    if (next === '*') {
      state.skip = true
      index++
      continue
    }
    const control = /^\\([a-z]+)(-?\d+)? ?/i.exec(source.slice(index))
    if (control) {
      const word = control[1]!.toLowerCase(), parameter = control[2] === undefined ? undefined : Number(control[2])
      index += control[0].length - 1
      if (RTF_DESTINATIONS.has(word)) { state.skip = true; continue }
      if (word === 'uc' && parameter !== undefined && parameter >= 0 && parameter <= 16) state.unicodeFallback = parameter
      else if (word === 'u' && parameter !== undefined) {
        if (!state.skip) append(String.fromCharCode((parameter + 65_536) % 65_536))
        fallbackRemaining = state.unicodeFallback
      } else if (!state.skip && (word === 'par' || word === 'line')) append('\n')
      else if (!state.skip && word === 'tab') append('\t')
      continue
    }
    index++
    if (fallbackRemaining) fallbackRemaining--
    else if (!state.skip && next === '~') append('\u00a0')
    else if (!state.skip && next === '_') append('\u2011')
  }
  return output.join('').replace(/[\t ]+\n/g, '\n').trim()
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: bytes.slice(), useSystemFonts: true, disableFontFace: true, enableXfa: false, stopAtErrors: false, verbosity: 0 })
  try {
    const document = await loading.promise
    const parts: string[] = []
    let length = 0
    for (let pageNumber = 1; pageNumber <= document.numPages && length < OFFICE_TEXT_MAX_CHARS; pageNumber++) {
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        for (const item of content.items) {
          if (!('str' in item)) continue
          const value = item.str + (item.hasEOL ? '\n' : ' ')
          const remaining = OFFICE_TEXT_MAX_CHARS - length
          if (remaining <= 0) break
          parts.push(value.slice(0, remaining))
          length += Math.min(value.length, remaining)
        }
      } finally { page.cleanup() }
    }
    return parts.join('').trim()
  } catch { throw new OfficeTextError('PDF 文档无法提取文本') }
  finally { await loading.destroy().catch(() => undefined) }
}

/**
 * Extract Office text with the same byte, row, column, shape, and character bounds as Python doctext.
 * Extraction is bounded before text reaches an Agent context.
 */
export async function extractOfficeText(input: Uint8Array, extension: string): Promise<string> {
  const ext = (extension || '').toLowerCase()
  if (LEGACY_EXTENSIONS.has(ext)) {
    throw new OfficeTextError(`旧式二进制 .${ext} 格式已不支持内容提取；文件本身完好，可让用户另存为 .${ext}x 等新格式后再试。`)
  }
  if (input.byteLength > OFFICE_TEXT_MAX_BYTES) throw new OfficeTextError('Office 文档超过 30MB 提取上限')
  let text: string
  if (ext === 'docx') {
    text = await extractDocx(input)
  } else if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') {
    text = extractWorkbook(input, ext)
  } else if (ext === 'pptx') {
    text = extractPptx(input)
  } else if (ext === 'odt' || ext === 'odp') {
    text = extractOdf(input, ext)
  } else if (ext === 'rtf') {
    text = extractRtf(input)
  } else if (ext === 'pdf') {
    text = await extractPdf(input)
  } else {
    throw new OfficeTextError(`.${ext || 'unknown'} 格式暂不支持 Office 文本提取`)
  }
  return truncateCodePoints(text, OFFICE_TEXT_MAX_CHARS)
}
