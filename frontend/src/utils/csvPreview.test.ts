// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { CSV_TABLE_PREVIEW_MAX_BYTES, decodeCsvText, readCsvWorkbook } from './csvPreview'

function toBuffer(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer
}

function toUtf16leBuffer(value: string): ArrayBuffer {
  const bytes = new Uint8Array(2 + value.length * 2)
  bytes.set([0xff, 0xfe])
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    bytes[2 + i * 2] = code & 0xff
    bytes[3 + i * 2] = code >> 8
  }
  return bytes.buffer
}

describe('CSV 表格预览解析', () => {
  it('正确解析 BOM、引号逗号、换行字段，并保留前导零', () => {
    const workbook = readCsvWorkbook(XLSX, toBuffer('\uFEFF编号,备注\r\n0012,"含,逗号"\r\n0013,"跨\n行"'))
    const sheet = workbook.Sheets[workbook.SheetNames[0]!]
    expect(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true })).toEqual([
      ['编号', '备注'],
      ['0012', '含,逗号'],
      ['0013', '跨\n行'],
    ])
  })

  it('按 UTF-8 解码中文 CSV，避免表格中出现 UTF-8 乱码', () => {
    const csv = 'id,name\n1,测试 A'
    const workbook = readCsvWorkbook(XLSX, toBuffer(csv))
    const sheet = workbook.Sheets[workbook.SheetNames[0]!]
    expect(XLSX.utils.sheet_to_json(sheet, { header: 1 })).toEqual([
      ['id', 'name'],
      ['1', '测试 A'],
    ])
  })

  it('兼容 GBK 和带 BOM 的 UTF-16 CSV', () => {
    const gbk = new Uint8Array([0x69, 0x64, 0x2c, 0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x31, 0x2c, 0xb2, 0xe2, 0xca, 0xd4])
    expect(decodeCsvText(gbk.buffer)).toBe('id,name\n1,测试')
    expect(decodeCsvText(toUtf16leBuffer('id,name\n1,测试'))).toBe('id,name\n1,测试')
  })

  it('CSV 超过表格预览上限时不启动整表解析', () => {
    expect(() => readCsvWorkbook(XLSX, new ArrayBuffer(CSV_TABLE_PREVIEW_MAX_BYTES + 1)))
      .toThrow('csv-preview-too-large')
  })
})
