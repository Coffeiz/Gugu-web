export interface XlsxPreviewArchiveEntry { name: string; size: number; compressedSize: number }
export interface XlsxPreviewArchive {
  rawSize: number
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

function xmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (entity[0] === '#') {
      const point = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error('xml entity')
      return String.fromCodePoint(point)
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()]!
  }).replace(/&[^;\s]+;/g, () => { throw new Error('xml entity') })
}

function parseXml(source: string): XmlNode {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) throw new Error('xml doctype')
  const root: XmlNode = { name: '', attrs: {}, text: '', children: [] }
  const stack = [root]
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:(?:"[^"]*")|(?:'[^']*')|[^'">])*?>|[^<]+/gy
  let offset = 0
  while (offset < source.length) {
    token.lastIndex = offset
    const match = token.exec(source)
    if (!match) throw new Error('xml token')
    const part = match[0]
    offset = token.lastIndex
    if (part.startsWith('<!--') || part.startsWith('<?')) continue
    if (part.startsWith('<![CDATA[')) { stack.at(-1)!.text += part.slice(9, -3); continue }
    if (part.startsWith('</')) {
      const name = part.slice(2, -1).trim()
      if (stack.length < 2 || stack.at(-1)!.name !== name) throw new Error('xml close')
      stack.pop()
      continue
    }
    if (part.startsWith('<!')) throw new Error('xml declaration')
    if (part.startsWith('<')) {
      const selfClosing = /\/\s*>$/.test(part)
      const body = part.slice(1, selfClosing ? part.lastIndexOf('/') : -1).trim()
      const nameMatch = /^([^\s/>]+)/.exec(body)
      if (!nameMatch) throw new Error('xml name')
      const node: XmlNode = { name: nameMatch[1]!, attrs: {}, text: '', children: [] }
      const attrs = body.slice(nameMatch[0].length)
      const attrToken = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy
      let attrOffset = 0
      while (attrOffset < attrs.length) {
        while (/\s/.test(attrs[attrOffset] ?? '')) attrOffset++
        if (attrOffset >= attrs.length) break
        attrToken.lastIndex = attrOffset
        const attr = attrToken.exec(attrs)
        if (!attr) throw new Error('xml attribute')
        attrOffset = attrToken.lastIndex
        const key = attr[1]!
        if (Object.hasOwn(node.attrs, key)) throw new Error('xml duplicate attribute')
        node.attrs[key] = xmlText(attr[2] ?? attr[3] ?? '')
      }
      stack.at(-1)!.children.push(node)
      if (!selfClosing) stack.push(node)
      continue
    }
    stack.at(-1)!.text += xmlText(part)
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error('xml root')
  return root.children[0]!
}

function walk(root: XmlNode): XmlNode[] { return [root, ...root.children.flatMap(walk)] }
function first(root: XmlNode, name: string): XmlNode | undefined { return walk(root).find(node => localName(node.name) === name) }
function direct(root: XmlNode, name: string): XmlNode[] { return root.children.filter(node => localName(node.name) === name) }
function attr(root: XmlNode | undefined, name: string): string | undefined {
  if (!root) return undefined
  return Object.entries(root.attrs).find(([key]) => localName(key) === name)?.[1]
}
function textOf(root: XmlNode): string { return root.text + root.children.map(textOf).join('') }
function resolvePath(base: string, target: string): string {
  const parts: string[] = []
  for (const part of `${base}/${target}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}
function columnNumber(reference: string): number {
  const letters = [...reference].filter(char => /[A-Za-z]/.test(char)).join('').toUpperCase()
  let column = 0
  for (const char of letters) column = column * 26 + char.charCodeAt(0) - 64
  return column
}
function cellPosition(reference: string): { row: number; col: number } | null {
  const letters = [...reference].filter(char => /[A-Za-z]/.test(char)).join('').toUpperCase()
  const digits = [...reference].filter(char => /\d/.test(char)).join('')
  const row = Number(digits), col = columnNumber(letters)
  return row > 0 && col > 0 ? { row, col } : null
}
function finiteFloat(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
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
    .map(item => [item.attrs.Id ?? '', item.attrs.Target ?? '']))
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

async function extractSheetData(archive: XlsxPreviewArchive): Promise<XlsxPreviewSheetData[]> {
  const entries = new Set(archive.entries.map(item => item.name))
  let sharedStrings: string[] = []
  if (entries.has('xl/sharedStrings.xml')) {
    const strings = await readXml(archive, 'xl/sharedStrings.xml')
    sharedStrings = direct(strings, 'si').map(textOf)
  }
  const workbook = await readXml(archive, 'xl/workbook.xml')
  const relations = relationMap(await readXml(archive, 'xl/_rels/workbook.xml.rels'))
  const result: XlsxPreviewSheetData[] = []
  for (const sheet of walk(workbook).filter(item => localName(item.name) === 'sheet')) {
    const name = sheet.attrs.name || '工作表'
    const target = relations.get(attr(sheet, 'id') ?? '')
    if (!target) { result.push({ name, cells: {}, merges: [], rowHeights: {}, colWidths: {}, rows: 0, cols: 0 }); continue }
    const root = await readXml(archive, resolvePath('xl', target))
    const cells: Record<string, string> = {}, rowHeights: Record<string, number> = {}, colWidths: Record<string, number> = {}
    let maxRow = 0, maxCol = 0
    for (const node of walk(root)) {
      if (localName(node.name) === 'row') {
        const row = Number(node.attrs.r ?? '0'), height = finiteFloat(node.attrs.ht)
        if (Number.isInteger(row) && row > 0 && row <= MAX_ROWS && height !== null) rowHeights[String(row - 1)] = Math.round(height * 1.333)
      } else if (localName(node.name) === 'col') {
        const start = Number(node.attrs.min ?? '1'), end = Number(node.attrs.max ?? String(start)), width = finiteFloat(node.attrs.width ?? '10')
        if (Number.isInteger(start) && Number.isInteger(end) && width !== null) {
          const pixels = Math.round(width * 8 + 16)
          for (let column = Math.max(0, start - 1); column < Math.min(MAX_COLS, end); column++) colWidths[String(column)] = Math.max(72, pixels)
        }
      }
    }
    for (const cell of walk(root).filter(item => localName(item.name) === 'c')) {
      const ref = cell.attrs.r, position = ref ? cellPosition(ref) : null
      if (!ref || !position || position.row > MAX_ROWS || position.col > MAX_COLS) continue
      const value = cell.children.find(item => ['v', 'is'].includes(localName(item.name)))
      let content = value ? textOf(value) : ''
      if (cell.attrs.t === 's') { const index = Number.parseInt(content, 10); content = Number.isInteger(index) ? sharedStrings[index] ?? '' : '' }
      else if (cell.attrs.t === 'inlineStr') content = value ? textOf(value) : ''
      cells[ref] = content
      maxRow = Math.max(maxRow, position.row)
      maxCol = Math.max(maxCol, position.col)
    }
    const merges: XlsxPreviewSheetData['merges'] = []
    for (const merge of walk(root).filter(item => localName(item.name) === 'mergeCell')) {
      const ref = merge.attrs.ref ?? '', [start, end] = ref.split(':')
      if (!start || !end) continue
      const begin = cellPosition(start), finish = cellPosition(end)
      if (!begin || !finish || begin.row > MAX_ROWS || begin.col > MAX_COLS) continue
      merges.push({ s: begin.row - 1, c: begin.col - 1, e: Math.min(finish.row - 1, MAX_ROWS - 1), d: Math.min(finish.col - 1, MAX_COLS - 1) })
      maxRow = Math.max(maxRow, Math.min(finish.row, MAX_ROWS))
      maxCol = Math.max(maxCol, Math.min(finish.col, MAX_COLS))
    }
    result.push({ name, cells, merges, rowHeights, colWidths, rows: Math.min(maxRow, MAX_ROWS), cols: Math.min(maxCol, MAX_COLS) })
  }
  return result
}

export async function extractXlsxPreview(archive: XlsxPreviewArchive): Promise<XlsxPreviewResult> {
  validateArchive(archive)
  let images: Awaited<ReturnType<typeof extractImages>>, data: XlsxPreviewSheetData[]
  try { [images, data] = await Promise.all([extractImages(archive), extractSheetData(archive)]) }
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
  async function read(storageKey: string, fileId: number, version: number): Promise<XlsxPreviewEntry> {
    const key = `${fileId}:${version}`
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
    async preview(storageKey: string, fileId: number, version: number) {
      const entry = await read(storageKey, fileId, version)
      return { version, sheets: entry.sheets }
    },
    async image(storageKey: string, fileId: number, version: number, imageId: number) {
      const entry = await read(storageKey, fileId, version), target = entry.imageTargets.get(imageId)
      if (!target) throw new XlsxPreviewError(404, '图片不存在')
      const content = await entry.archive.read(target.path)
      if (!content) throw new XlsxPreviewError(404, '图片不存在')
      return { content, mime: target.mime }
    },
  }
}
