import { describe, expect, it } from 'vitest'
import { extractXlsxPreview, type XlsxPreviewArchive } from '../../src/files/xlsx-preview.js'
import * as XLSX from 'xlsx'

function workbookBytes(value: string, layout = false): Uint8Array {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([[value]])
  if (layout) {
    sheet['BI1'] = { t: 's', v: 'ignored' }
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }]
    sheet['!rows'] = [{ hpt: 18 }]
    sheet['!cols'] = [{ width: 10 }, { width: 10 }]
  }
  XLSX.utils.book_append_sheet(workbook, sheet, '工作表1')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array
}

function archive(entries: Record<string, string | Uint8Array>, limits: Partial<Record<string, { size: number; compressedSize: number }>> = {}, rawWorkbook = workbookBytes('')): XlsxPreviewArchive {
  const items = Object.entries(entries).map(([name, value]) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    const limit = limits[name]
    return { name, size: limit?.size ?? bytes.byteLength, compressedSize: limit?.compressedSize ?? bytes.byteLength, bytes }
  })
  return {
    rawSize: rawWorkbook.byteLength,
    rawWorkbook,
    entries: items.map(({ name, size, compressedSize }) => ({ name, size, compressedSize })),
    async read(name) {
      const item = items.find(entry => entry.name === name)
      return item?.bytes ?? null
    },
  }
}

const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工作表1" sheetId="1" r:id="rId1"/></sheets></workbook>`
const workbookRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`

describe('XLSX preview parsing', () => {
  it('uses SheetJS to read worksheet cell values from the source workbook', async () => {
    const result = await extractXlsxPreview(archive({
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': workbookRels,
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>manual-parser-value</t></is></c></row></sheetData></worksheet>',
    }, {}, workbookBytes('sheetjs-value')))

    expect(result.sheets[0]?.data.cells).toEqual({ A1: 'sheetjs-value' })
  })

  it('extracts a bounded worksheet view and preserves Python response fields', async () => {
    const result = await extractXlsxPreview(archive({
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': workbookRels,
      'xl/sharedStrings.xml': '<sst><si><t>标题 &amp; 正文</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><cols><col min="1" max="2" width="10"/></cols><sheetData><row r="1" ht="18"><c r="A1" t="s"><v>0</v></c><c r="BI1"><v>ignored</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B2"/></mergeCells></worksheet>',
    }, {}, workbookBytes('标题 & 正文', true)))

    expect(result.sheets).toEqual([{
      images: {},
      data: {
        name: '工作表1', cells: { A1: '标题 & 正文' }, merges: [{ s: 0, c: 0, e: 1, d: 1 }],
        rowHeights: { '0': 24 }, colWidths: { '0': 96, '1': 96 }, rows: 2, cols: 2,
      },
    }])
  })

  it('rejects duplicate archive paths before reading untrusted worksheet XML', async () => {
    const duplicate = archive({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': workbookRels })
    ;(duplicate as { entries: readonly { name: string; size: number; compressedSize: number }[] }).entries = [
      ...duplicate.entries,
      duplicate.entries[0]!,
    ]
    await expect(extractXlsxPreview(duplicate)).rejects.toMatchObject({ statusCode: 400, detail: 'XLSX 文件包含重复压缩条目' })
  })

  it('rejects an excessive compression ratio before reading an entry', async () => {
    const source = archive({ 'xl/workbook.xml': workbook }, {
      'xl/workbook.xml': { size: 20_000, compressedSize: 100 },
    })
    let read = false
    const guarded = { ...source, async read() { read = true; return null } }
    await expect(extractXlsxPreview(guarded)).rejects.toMatchObject({ statusCode: 413, detail: 'XLSX 压缩比超过预览安全限制' })
    expect(read).toBe(false)
  })

  it('rejects invalid XML control characters in workbook metadata', async () => {
    const invalidWorkbook = workbook.replace('<sheets>', '<sheets>\u0001')
    await expect(extractXlsxPreview(archive({
      'xl/workbook.xml': invalidWorkbook,
      'xl/_rels/workbook.xml.rels': workbookRels,
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData/></worksheet>',
    }))).rejects.toMatchObject({ statusCode: 400, detail: 'XLSX 文件内容损坏' })
  })

  it('rejects undeclared XML entities in workbook metadata', async () => {
    const invalidWorkbook = workbook.replace('<sheets>', '<sheets>&untrusted;')
    await expect(extractXlsxPreview(archive({
      'xl/workbook.xml': invalidWorkbook,
      'xl/_rels/workbook.xml.rels': workbookRels,
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData/></worksheet>',
    }))).rejects.toMatchObject({ statusCode: 400, detail: 'XLSX 文件内容损坏' })
  })
})
