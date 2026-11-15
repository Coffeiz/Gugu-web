import { openAuthorizedRelativeFile } from '@gugu/core/files/read'
import { createXlsxPreviewReader, XlsxPreviewError, type XlsxPreviewArchive, type XlsxPreviewArchiveEntry } from '@gugu/core/files/xlsx-preview'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import JSZip from 'jszip'
import type { Pool, QueryResultRow } from 'pg'
import { isOwnedFileStorageKey } from '../../domains/files/file-owner.js'
import { CoreError } from '@gugu/core'

const MAX_FILE_BYTES = 256 * 1024 * 1024
type CentralEntry = XlsxPreviewArchiveEntry
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function decodeZipName(bytes: Buffer, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return Array.from(bytes, byte => byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80] ?? '').join('')
}

function u64(buffer: Buffer, offset: number): bigint { return buffer.readBigUInt64LE(offset) }
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new XlsxPreviewError(413, 'XLSX 文件超过预览大小限制')
  return Number(value)
}

/** 读取 ZIP central directory 的原始条目；JSZip 会按名称折叠重复项，因此在它解压前先保留 Python ZipFile 可见的条目清单。 */
function centralDirectory(raw: Buffer): CentralEntry[] {
  const lower = Math.max(0, raw.length - 65_557)
  let eocd = -1
  for (let offset = raw.length - 22; offset >= lower; offset--) {
    if (raw.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
  let count = raw.readUInt16LE(eocd + 10), directorySize = raw.readUInt32LE(eocd + 12), directoryOffset = raw.readUInt32LE(eocd + 16)
  if (raw.readUInt16LE(eocd + 4) !== 0 || raw.readUInt16LE(eocd + 6) !== 0
    || raw.readUInt16LE(eocd + 8) !== count) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20
    if (locator < 0 || raw.readUInt32LE(locator) !== 0x07064b50 || raw.readUInt32LE(locator + 4) !== 0
      || raw.readUInt32LE(locator + 16) !== 1) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    const recordOffset = safeNumber(u64(raw, locator + 8))
    if (raw.readUInt32LE(recordOffset) !== 0x06064b50) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    if (raw.readUInt32LE(recordOffset + 16) !== 0 || raw.readUInt32LE(recordOffset + 20) !== 0)
      throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    count = safeNumber(u64(raw, recordOffset + 32))
    directorySize = safeNumber(u64(raw, recordOffset + 40))
    directoryOffset = safeNumber(u64(raw, recordOffset + 48))
  }
  if (count > 20_000 || directoryOffset + directorySize > raw.length || directoryOffset > raw.length)
    throw new XlsxPreviewError(413, 'XLSX 文件条目数量超过预览限制')
  const entries: CentralEntry[] = []
  let offset = directoryOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > raw.length || raw.readUInt32LE(offset) !== 0x02014b50) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    const flags = raw.readUInt16LE(offset + 8)
    let compressedSize = raw.readUInt32LE(offset + 20), size = raw.readUInt32LE(offset + 24)
    const nameLength = raw.readUInt16LE(offset + 28), extraLength = raw.readUInt16LE(offset + 30), commentLength = raw.readUInt16LE(offset + 32)
    const nameStart = offset + 46, extraStart = nameStart + nameLength, next = extraStart + extraLength + commentLength
    if (next > raw.length || next > directoryOffset + directorySize) throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
    let name: string
    try { name = decodeZipName(raw.subarray(nameStart, extraStart), Boolean(flags & 0x800)) }
    catch { throw new XlsxPreviewError(400, 'XLSX 文件名编码无效') }
    if (size === 0xffffffff || compressedSize === 0xffffffff) {
      const extraEnd = extraStart + extraLength
      let extra = extraStart, found = false
      while (extra + 4 <= extraEnd) {
        const type = raw.readUInt16LE(extra), length = raw.readUInt16LE(extra + 2), start = extra + 4, end = start + length
        if (end > extraEnd) throw new XlsxPreviewError(400, 'XLSX 文件结构不完整')
        if (type === 0x0001) {
          let cursor = start
          if (size === 0xffffffff) { size = safeNumber(u64(raw, cursor)); cursor += 8 }
          if (compressedSize === 0xffffffff) { compressedSize = safeNumber(u64(raw, cursor)); cursor += 8 }
          found = true; break
        }
        extra = end
      }
      if (!found) throw new XlsxPreviewError(400, 'XLSX 文件结构不完整')
    }
    entries.push({ name, size, compressedSize })
    offset = next
  }
  return entries
}

async function loadArchive(raw: Buffer): Promise<XlsxPreviewArchive> {
  if (raw.byteLength > MAX_FILE_BYTES) throw new XlsxPreviewError(413, 'XLSX 文件超过预览大小限制')
  const entries = centralDirectory(raw)
  try {
    const zip = await JSZip.loadAsync(raw, { checkCRC32: false, createFolders: false })
    const byName = new Map(Object.entries(zip.files).map(([name, file]) => [name, file]))
    return {
      rawSize: raw.byteLength,
      rawWorkbook: raw,
      entries,
      async read(name) {
        const file = byName.get(name)
        if (!file || file.dir) return null
        try { return await file.async('uint8array') } catch { throw new XlsxPreviewError(400, 'XLSX 文件内容损坏') }
      },
    }
  } catch (error) {
    if (error instanceof XlsxPreviewError) throw error
    throw new XlsxPreviewError(400, '不是有效的 XLSX 文件')
  }
}

type PreviewFileRow = QueryResultRow & { id: number | string; storage_key: string; ext: string; version: number | string | null }

export function createPostgresXlsxPreviewOperations(pool: Pick<Pool, 'query'>, storageRoot: string) {
  const reader = createXlsxPreviewReader(async storageKey => {
    const opened = await openAuthorizedRelativeFile(storageKey, key => openLocalFile(storageRoot, key), error => error instanceof UnsafeLocalPathError)
    if (!opened) throw new CoreError('not_found', '物理文件丢失')
    try {
      if (opened.size > MAX_FILE_BYTES) throw new XlsxPreviewError(413, 'XLSX 文件超过预览大小限制')
      return await loadArchive(await opened.handle.readFile())
    } finally { await opened.handle.close() }
  })

  async function ownedXlsx(ownerId: string, fileId: number): Promise<PreviewFileRow> {
    if (!Number.isSafeInteger(fileId)) throw new CoreError('invalid_request', '文件 ID 无效')
    const result = await pool.query<PreviewFileRow>(
      'SELECT id,storage_key,ext,version FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
      [fileId, ownerId],
    )
    const file = result.rows[0]
    if (!file || !isOwnedFileStorageKey(ownerId, file.storage_key)) throw new CoreError('not_found', '文件不存在')
    if ((file.ext || '').toLowerCase() !== 'xlsx') throw new XlsxPreviewError(415, '仅支持 XLSX 文件')
    return file
  }

  return {
    async xlsxPreview(ownerId: string, fileId: number) {
      const file = await ownedXlsx(ownerId, fileId)
      return reader.preview(file.storage_key, Number(file.id), Number(file.version ?? 1))
    },
    async xlsxPreviewImage(ownerId: string, fileId: number, imageId: number) {
      const file = await ownedXlsx(ownerId, fileId)
      return reader.image(file.storage_key, Number(file.id), Number(file.version ?? 1), imageId)
    },
  }
}
