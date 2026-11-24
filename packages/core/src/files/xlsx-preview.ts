import * as XLSX from 'xlsx'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export interface XlsxPreviewArchiveEntry { name: string; size: number; compressedSize: number }
export interface XlsxPreviewArchive {
  rawSize: number
  rawWorkbook: Uint8Array
  entries: readonly XlsxPreviewArchiveEntry[]
  read(name: string): Promise<Uint8Array | null>
}

export interface XlsxPreviewImage { id: number; width?: number; height?: number }
export interface XlsxPreviewSheetData {
  name: string
  cells: Record<string, string>
  merges: Array<{ s: number; c: number; e: number; d: number }>
  rowHeights: Record<string, number>
  colWidths: Record<string, number>
  rows: number
  cols: number
}
export interface XlsxPreviewSheet {
  images: Record<string, XlsxPreviewImage[]>
  data: XlsxPreviewSheetData
}
export interface XlsxPreviewImageTarget { path: string; mime: string }
export interface XlsxPreviewResult { sheets: XlsxPreviewSheet[]; imageTargets: ReadonlyMap<number, XlsxPreviewImageTarget> }
export interface XlsxPreviewEntry extends XlsxPreviewResult { archive: XlsxPreviewArchive; sizeBytes: number }

const MAX_CACHE_ENTRIES = 4
const MAX_CACHE_BYTES = 128 * 1024 * 1024
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024
const MAX_ENTRY_UNCOMPRESSED = 128 * 1024 * 1024
const MAX_XML_BYTES = 64 * 1024 * 1024
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 100
const MAX_ROWS = 500
const MAX_COLS = 60

export class XlsxPreviewError extends Error {
  readonly statusCode: number
  readonly detail: string
  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'XlsxPreviewError'
    this.statusCode = statusCode
    this.detail = message
  }
}

type XmlNode = { name: string; attrs: Record<string, string>; text: string; children: XmlNode[] }
const localName = (name: string) => name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  maxNestedTags: 128,
})

type OrderedXmlEntry = Record<string, unknown>
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validXmlCodePoint(point: number): boolean {
  return point === 0x9 || point === 0xa || point === 0xd
    || point >= 0x20 && point <= 0xd7ff
    || point >= 0xe000 && point <= 0xfffd
    || point >= 0x10000 && point <= 0x10ffff
}

function validateXmlEntities(source: string): void {
  const predefined = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])
  for (const [, entity] of source.matchAll(/&([^;\s<&]*);/g)) {
    if (predefined.has(entity!)) continue
    const hexadecimal = /^#x([\da-f]+)$/i.exec(entity!)
    const decimal = /^#(\d+)$/.exec(entity!)
    const point = hexadecimal ? Number.parseInt(hexadecimal[1]!, 16)
      : decimal ? Number.parseInt(decimal[1]!, 10) : Number.NaN
    if (!Number.isSafeInteger(point) || !validXmlCodePoint(point)) throw new Error('xml entity')
  }
}

function orderedNode(name: string, content: unknown, attributes?: unknown): XmlNode {
  const node: XmlNode = { name, attrs: {}, text: '', children: [] }
  if (attributes !== undefined) {
    if (!isRecord(attributes)) throw new Error('xml attributes')
    for (const [attribute, attributeValue] of Object.entries(attributes)) {
      if (!attribute.startsWith('@_') || typeof attributeValue !== 'string') throw new Error('xml attribute')
      const attributeName = attribute.slice(2)
      if (Object.hasOwn(node.attrs, attributeName)) throw new Error('xml duplicate attribute')
      node.attrs[attributeName] = attributeValue
    }
  }
  const entries = Array.isArray(content) ? content : [content]
  for (const entry of entries) {
    if (!isRecord(entry)) throw new Error('xml node')
    for (const [key, value] of Object.entries(entry as OrderedXmlEntry)) {
      if (key === ':@') {
        continue
      } else if (key === '#text' || key === '#cdata') {
        if (typeof value !== 'string') throw new Error('xml text')
        node.text += value
      } else if (key.startsWith('?')) {
        continue
      } else {
        node.children.push(orderedNode(key, value, entry[':@']))
      }
    }
  }
  return node
}

function parseXml(source: string): XmlNode {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) throw new Error('xml doctype')
  if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(source)) throw new Error('xml character')
  validateXmlEntities(source)
  if (XMLValidator.validate(source) !== true) throw new Error('xml invalid')
  const parsed = xmlParser.parse(source) as unknown
  if (!Array.isArray(parsed)) throw new Error('xml root')
  const roots = parsed.filter(isRecord).flatMap(entry => Object.entries(entry)
    .filter(([name]) => !name.startsWith('?') && name !== ':@')
    .map(([name, content]) => ({ name, content, attributes: entry[':@'] })))
  if (roots.length !== 1) throw new Error('xml root')
  const root = roots[0]!
  return orderedNode(root.name, root.content, root.attributes)
}

function walk(root: XmlNode): XmlNode[] { return [root, ...root.children.flatMap(walk)] }
function first(root: XmlNode, name: string): XmlNode | undefined { return walk(root).find(node => localName(node.name) === name) }
function attr(root: XmlNode | undefined, name: string): string | undefined {
  if (!root) return undefined
  return Object.entries(root.attrs).find(([key]) => localName(key.replace(/^@_/, '')) === name)?.[1]
}
function resolvePath(base: string, target: string): string {
  const parts: string[] = []
  for (const part of `${base}/${target}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}
function validateArchive(archive: XlsxPreviewArchive): void {
  if (archive.rawSize > MAX_FILE_BYTES) throw new XlsxPreviewError(413, 'XLSX 文件超过预览大小限制')
  if (archive.entries.length > MAX_ARCHIVE_ENTRIES) throw new XlsxPreviewError(413, 'XLSX 文件条目数量超过预览限制')
  let total = 0
  const names = new Set<string>()
  for (const entry of archive.entries) {
    if (names.has(entry.name)) throw new XlsxPreviewError(400, 'XLSX 文件包含重复压缩条目')
    names.add(entry.name)
    if (entry.size > MAX_ENTRY_UNCOMPRESSED) throw new XlsxPreviewError(413, 'XLSX 压缩条目超过预览大小限制')
    total += entry.size
    if (total > MAX_TOTAL_UNCOMPRESSED) throw new XlsxPreviewError(413, 'XLSX 解压总大小超过预览限制')
    if (entry.compressedSize > 0 && entry.size / entry.compressedSize > MAX_COMPRESSION_RATIO)
      throw new XlsxPreviewError(413, 'XLSX 压缩比超过预览安全限制')
    if (entry.name.startsWith('xl/media/') && entry.size > MAX_IMAGE_BYTES)
      throw new XlsxPreviewError(413, 'XLSX 图片超过预览大小限制')
  }
}

function decodeXml(bytes: Uint8Array): XmlNode {
  try { return parseXml(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new XlsxPreviewError(400, 'XLSX 文件内容损坏') }
}

async function readXml(archive: XlsxPreviewArchive, name: string): Promise<XmlNode> {
  const entry = archive.entries.find(item => item.name === name)
  if (!entry) throw new XlsxPreviewError(400, 'XLSX 文件结构不完整')
  if (entry.size > MAX_XML_BYTES) throw new XlsxPreviewError(413, 'XLSX XML 内容超过预览限制')
  const bytes = await archive.read(name)
  if (bytes === null) throw new XlsxPreviewError(400, 'XLSX 文件内容损坏')
  return decodeXml(bytes)
}

function relationMap(root: XmlNode): Map<string, string> {
  return new Map(walk(root).filter(item => localName(item.name) === 'Relationship')
    .map(item => [attr(item, 'Id') ?? '', attr(item, 'Target') ?? '']))
}

async function extractImages(archive: XlsxPreviewArchive): Promise<{ sheets: Array<Record<string, XlsxPreviewImage[]>>; imageTargets: Map<number, XlsxPreviewImageTarget> }> {
  const workbook = await readXml(archive, 'xl/workbook.xml')
  const workbookRels = relationMap(await readXml(archive, 'xl/_rels/workbook.xml.rels'))
  const entries = new Set(archive.entries.map(item => item.name))
  const sheets: Array<Record<string, XlsxPreviewImage[]>> = []
  const imageTargets = new Map<number, XlsxPreviewImageTarget>()
  let nextId = 0
  const mimeByExtension: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }
  for (const sheet of walk(workbook).filter(item => localName(item.name) === 'sheet')) {
    const target = workbookRels.get(attr(sheet, 'id') ?? '')
    if (!target) { sheets.push({}); continue }
    const sheetPath = resolvePath('xl', target), sheetRoot = await readXml(archive, sheetPath)
    const drawing = first(sheetRoot, 'drawing')
    if (!drawing) { sheets.push({}); continue }
    const drawingId = attr(drawing, 'id') ?? ''
    const slash = sheetPath.lastIndexOf('/'), sheetDir = slash < 0 ? '' : sheetPath.slice(0, slash)
    const sheetName = sheetPath.slice(slash + 1)
    const drawingRelsPath = `${sheetDir}/_rels/${sheetName}.rels`
    const drawingTarget = relationMap(await readXml(archive, drawingRelsPath)).get(drawingId)
    if (!drawingTarget) { sheets.push({}); continue }
    const drawingPath = resolvePath(sheetDir, drawingTarget), drawingRoot = await readXml(archive, drawingPath)
    const drawingSlash = drawingPath.lastIndexOf('/'), drawingDir = drawingSlash < 0 ? '' : drawingPath.slice(0, drawingSlash)
    const drawingName = drawingPath.slice(drawingSlash + 1)
    const mediaTargets = relationMap(await readXml(archive, `${drawingDir}/_rels/${drawingName}.rels`))
    const images: Record<string, XlsxPreviewImage[]> = {}
    for (const anchor of walk(drawingRoot).filter(item => ['oneCellAnchor', 'twoCellAnchor'].includes(localName(item.name)))) {
      const from = first(anchor, 'from'), pic = first(anchor, 'pic'), blip = pic ? first(pic, 'blip') : undefined
      const mediaTarget = mediaTargets.get(attr(blip, 'embed') ?? '')
      if (!from || !mediaTarget) continue
      const row = Number(first(from, 'row')?.text ?? '-1'), col = Number(first(from, 'col')?.text ?? '-1')
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLS) continue
      const mediaPath = resolvePath(drawingDir, mediaTarget)
      if (!entries.has(mediaPath)) continue
      const extension = mediaPath.split('.').at(-1)?.toLowerCase() ?? ''
      const image: XlsxPreviewImage = { id: nextId }
      imageTargets.set(nextId++, { path: mediaPath, mime: mimeByExtension[extension] ?? 'application/octet-stream' })
      const extent = first(anchor, 'ext')
      const cx = Number.parseInt(extent?.attrs.cx ?? '0', 10), cy = Number.parseInt(extent?.attrs.cy ?? '0', 10)
      const width = Math.trunc(cx / 9525), height = Math.trunc(cy / 9525)
      if (width > 0) image.width = width
      if (height > 0) image.height = height
      ;(images[`${row}:${col}`] ??= []).push(image)
    }
    sheets.push(images)
  }
  return { sheets, imageTargets }
}

function xlsxCellText(cell: XLSX.CellObject): string {
  if (cell.t === 'b') return cell.v ? '1' : '0'
  if (cell.t === 'e' && cell.w) return cell.w
  return cell.v == null ? '' : String(cell.v)
}

function extractSheetData(rawWorkbook: Uint8Array): XlsxPreviewSheetData[] {
  const workbook = XLSX.read(rawWorkbook, { type: 'array', cellDates: false, cellText: true, cellStyles: true })
  const result: XlsxPreviewSheetData[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]!
    const cells: Record<string, string> = {}, rowHeights: Record<string, number> = {}, colWidths: Record<string, number> = {}
    let maxRow = 0, maxCol = 0
    for (const [reference, cell] of Object.entries(sheet)) {
      if (reference.startsWith('!')) continue
      let position: XLSX.CellAddress
      try { position = XLSX.utils.decode_cell(reference) } catch { continue }
      if (position.r >= MAX_ROWS || position.c >= MAX_COLS || !cell || typeof cell !== 'object' || !('v' in cell)) continue
      cells[reference] = xlsxCellText(cell as XLSX.CellObject)
      maxRow = Math.max(maxRow, position.r + 1)
      maxCol = Math.max(maxCol, position.c + 1)
    }
    for (const [index, row] of (sheet['!rows'] ?? []).entries()) {
      if (index >= MAX_ROWS || !row) continue
      const pixels = typeof row.hpt === 'number' ? Math.round(row.hpt * 1.333) : typeof row.hpx === 'number' ? row.hpx : null
      if (pixels !== null && pixels > 0) rowHeights[String(index)] = pixels
    }
    for (const [index, column] of (sheet['!cols'] ?? []).entries()) {
      if (index >= MAX_COLS || !column) continue
      const pixels = typeof column.width === 'number' ? Math.round(column.width * 8 + 16)
        : typeof column.wch === 'number' ? Math.round(column.wch * 8 + 16) : null
      if (pixels !== null && pixels > 0) colWidths[String(index)] = Math.max(72, pixels)
    }
    const merges: XlsxPreviewSheetData['merges'] = []
    for (const merge of sheet['!merges'] ?? []) {
      if (merge.s.r >= MAX_ROWS || merge.s.c >= MAX_COLS) continue
      merges.push({
        s: merge.s.r, c: merge.s.c,
        e: Math.min(merge.e.r, MAX_ROWS - 1), d: Math.min(merge.e.c, MAX_COLS - 1),
      })
      maxRow = Math.max(maxRow, Math.min(merge.e.r + 1, MAX_ROWS))
      maxCol = Math.max(maxCol, Math.min(merge.e.c + 1, MAX_COLS))
    }
    result.push({ name, cells, merges, rowHeights, colWidths, rows: Math.min(maxRow, MAX_ROWS), cols: Math.min(maxCol, MAX_COLS) })
  }
  return result
}

export async function extractXlsxPreview(archive: XlsxPreviewArchive): Promise<XlsxPreviewResult> {
  validateArchive(archive)
  let images: Awaited<ReturnType<typeof extractImages>>, data: XlsxPreviewSheetData[]
  try { [images, data] = await Promise.all([extractImages(archive), Promise.resolve().then(() => extractSheetData(archive.rawWorkbook))]) }
  catch (error) {
    if (error instanceof XlsxPreviewError) throw error
    throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
  }
  return {
    sheets: Array.from({ length: Math.max(images.sheets.length, data.length) }, (_, index) => ({
      images: images.sheets[index] ?? {},
      data: data[index] ?? { name: '工作表', cells: {}, merges: [], rowHeights: {}, colWidths: {}, rows: 0, cols: 0 },
    })),
    imageTargets: images.imageTargets,
  }
}

export function createXlsxPreviewReader(load: (storageKey: string) => Promise<XlsxPreviewArchive>) {
  const cache = new Map<string, XlsxPreviewEntry>()
  const inflight = new Map<string, Promise<XlsxPreviewEntry>>()
  let cachedBytes = 0
  async function read(storageKey: string, version: number): Promise<XlsxPreviewEntry> {
    const key = `${storageKey}:${version}`
    const existing = cache.get(key)
    if (existing) { cache.delete(key); cache.set(key, existing); return existing }
    let task = inflight.get(key)
    if (!task) {
      task = (async () => {
        const archive = await load(storageKey)
        const result = await extractXlsxPreview(archive)
        const entry = { ...result, archive, sizeBytes: archive.rawSize }
        cache.set(key, entry); cachedBytes += entry.sizeBytes
        while (cache.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
          const oldestKey = cache.keys().next().value as string | undefined
          if (oldestKey === undefined) break
          cachedBytes -= cache.get(oldestKey)!.sizeBytes
          cache.delete(oldestKey)
        }
        return entry
      })()
      inflight.set(key, task)
    }
    try { return await task } finally { if (inflight.get(key) === task) inflight.delete(key) }
  }
  return {
    async preview(storageKey: string, version: number) {
      const entry = await read(storageKey, version)
      return { version, sheets: entry.sheets }
    },
    async image(storageKey: string, version: number, imageId: number) {
      const entry = await read(storageKey, version), target = entry.imageTargets.get(imageId)
      if (!target) throw new XlsxPreviewError(404, '图片不存在')
      const content = await entry.archive.read(target.path)
      if (!content) throw new XlsxPreviewError(404, '图片不存在')
      return { content, mime: target.mime }
    },
  }
}
