export const CSV_TABLE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

/** CSV 常见导出字符集：优先严格 UTF-8，兼容 UTF-16 BOM 和 Windows 中文 GBK。 */
export function decodeCsvText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2))
  }

  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset))
  } catch {
    return new TextDecoder('gbk', { fatal: true }).decode(bytes)
  }
}

/** 用 SheetJS 读取已解码的 CSV，并保留字段原始字符串（例如带前导零的编号）。 */
export function readCsvWorkbook(XLSX: typeof import('xlsx'), buffer: ArrayBuffer) {
  if (buffer.byteLength > CSV_TABLE_PREVIEW_MAX_BYTES) {
    throw new Error('csv-preview-too-large')
  }
  const workbook = XLSX.read(decodeCsvText(buffer), { type: 'string', raw: true })
  if (!workbook.SheetNames.length) throw new Error('empty-csv')
  return workbook
}
