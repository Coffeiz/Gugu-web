import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { extractOfficeText } from '../../src/files/office-text.js'

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipStored(entries: Record<string, string>): Uint8Array {
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name)
    const data = Buffer.from(value)
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, data)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(data.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, nameBytes)
    offset += header.length + nameBytes.length + data.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

function docxFixture(): Uint8Array {
  return zipStored({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段正文</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  })
}

function pptxFixture(): Uint8Array {
  return zipStored({
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>标题页</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>第一行要点</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/notesSlides/notesSlide1.xml': '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>讲者备注</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:notes>',
  })
}

function odtFixture(): Uint8Array {
  return zipStored({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:text><text:p>第一段</text:p><table:table><table:table-row><table:table-cell><text:p>甲</text:p></table:table-cell><table:table-cell><text:p>乙</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>',
  })
}

function odpFixture(): Uint8Array {
  return zipStored({
    mimetype: 'application/vnd.oasis.opendocument.presentation',
    'content.xml': '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body><office:presentation><draw:page><draw:frame><draw:text-box><text:p>演示页正文</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>',
  })
}

function pdfFixture(): Uint8Array {
  const stream = 'BT /F1 18 Tf 72 720 Td (Gugu PDF text) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Uint8Array.from(Buffer.from(pdf, 'ascii'))
}

function reorderedPptxFixture(): Uint8Array {
  return zipStored({
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="2" r:id="rId2"/><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第一张</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第二张 &amp; 表格</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>甲</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>乙</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide2.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide4.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide4.xml': '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第二页备注</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:notes>',
  })
}

function withOversizedPptxEntry(bytes: Uint8Array): Uint8Array {
  const malicious = Buffer.from(bytes)
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  const centralOffset = malicious.indexOf(signature)
  if (centralOffset < 0) throw new Error('fixture central directory is missing')
  malicious.writeUInt32LE(128 * 1024 * 1024 + 1, centralOffset + 24)
  return malicious
}

function withOversizedDocxEntry(bytes: Uint8Array): Uint8Array {
  const malicious = Buffer.from(bytes)
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  const centralOffset = malicious.indexOf(signature)
  if (centralOffset < 0) throw new Error('fixture central directory is missing')
  malicious.writeUInt32LE(128 * 1024 * 1024 + 1, centralOffset + 24)
  return malicious
}

describe('Office 正文提取（Python doctext 基线与 ODF 适配）', () => {
  it('从 PDF 页文本读取正文', async () => {
    expect(await extractOfficeText(pdfFixture(), 'pdf')).toContain('Gugu PDF text')
  })

  it('提取 DOCX 段落与表格行，保留表格单元格分隔', async () => {
    const text = await extractOfficeText(docxFixture(), 'docx')
    expect(text).toContain('第一段正文')
    expect(text).toContain('甲\t乙')
  })

  it('在 Mammoth 解包前拒绝 DOCX 中声明超大解压内容的压缩包', async () => {
    await expect(extractOfficeText(withOversizedDocxEntry(docxFixture()), 'docx')).rejects.toThrow('解压内容超过安全上限')
  })

  it('按工作表名、行列上限和 Python 兼容格式读取 XLSX', async () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['名称', '数量'], ['苹果', 3]])
    XLSX.utils.book_append_sheet(workbook, sheet, '数据')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array
    const text = await extractOfficeText(bytes, 'xlsx')
    expect(text).toContain('## 数据')
    expect(text).toContain('名称\t数量')
    expect(text).toContain('苹果\t3')
  })

  it('XLSX 日期单元格投影为 Python datetime 的可读文本', async () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['日期'], [new Date('2024-01-02T03:04:05.000Z')]])
    sheet.A2!.z = 'yyyy-mm-dd hh:mm:ss'
    XLSX.utils.book_append_sheet(workbook, sheet, '日期')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array
    expect(await extractOfficeText(bytes, 'xlsx')).toContain('2024-01-02 03:04:05')
  })

  it('读取 SheetJS 支持的 BIFF8 XLS，并保留工作表名和单元格顺序', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['编号', '名称'], [7, '样例']]), '旧表')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xls' }) as Uint8Array
    const text = await extractOfficeText(bytes, 'xls')
    expect(text).toContain('## 旧表')
    expect(text).toContain('编号\t名称')
    expect(text).toContain('7\t样例')
  })

  it('读取 ODS 表名、行和单元格文本', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['项目', '状态'], ['迁移', '完成']]), '计划')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }) as Uint8Array
    const text = await extractOfficeText(bytes, 'ods')
    expect(text).toContain('## 计划')
    expect(text).toContain('项目\t状态')
    expect(text).toContain('迁移\t完成')
  })

  it('从 RTF 控制词和段落标记提取可读文字', async () => {
    const bytes = Buffer.from('{\\rtf1\\ansi First paragraph \\b bold\\b0\\par Second paragraph}', 'ascii')
    const text = await extractOfficeText(bytes, 'rtf')
    expect(text).toContain('First paragraph')
    expect(text).toContain('bold')
    expect(text).toContain('Second paragraph')
    expect(text).not.toContain('\\par')
  })

  it('读取 RTF Unicode 转义并保留嵌套样式组中的正文', async () => {
    const bytes = Buffer.from('{\\rtf1\\ansi\\uc1 Hello {\\b bold {\\i italic}} \\u20013?}', 'ascii')
    const text = await extractOfficeText(bytes, 'rtf')
    expect(text).toContain('bold')
    expect(text).toContain('italic')
    expect(text).toContain('中')
  })

  it('从 ODT 内容 XML 提取段落和表格文字', async () => {
    const text = await extractOfficeText(odtFixture(), 'odt')
    expect(text).toContain('第一段')
    expect(text).toContain('甲')
    expect(text).toContain('乙')
  })

  it('修复旧实现把 ODP ZIP 原始字节误当 UTF-8 的问题，提取幻灯片文字', async () => {
    const text = await extractOfficeText(odpFixture(), 'odp')
    expect(text).toContain('演示页正文')
  })

  it('按幻灯片顺序提取形状和备注', async () => {
    const text = await extractOfficeText(pptxFixture(), 'pptx')
    expect(text).toContain('## 幻灯片 1')
    expect(text).toContain('标题页')
    expect(text).toContain('第一行要点')
    expect(text).toContain('[备注] 讲者备注')
  })

  it('按 Presentation 关系顺序读取幻灯片、表格行和实际 Notes 关系', async () => {
    const text = await extractOfficeText(reorderedPptxFixture(), 'pptx')
    expect(text.indexOf('第二张')).toBeLessThan(text.indexOf('第一张'))
    expect(text).toContain('第二张 & 表格')
    expect(text).toContain('甲\t乙')
    expect(text).toContain('[备注] 第二页备注')
  })

  it('拒绝声明超大解压内容的幻灯片压缩包，避免解压炸弹占用内存', async () => {
    await expect(extractOfficeText(withOversizedPptxEntry(pptxFixture()), 'pptx')).rejects.toThrow('解压内容超过安全上限')
  })

  it('拒绝含 DTD 或实体声明的幻灯片 XML', async () => {
    const bytes = zipStored({
      'ppt/slides/slide1.xml': '<!DOCTYPE p:sld [<!ENTITY x "危险">]><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:spTree>&x;</p:spTree></p:sld>',
    })
    await expect(extractOfficeText(bytes, 'pptx')).rejects.toThrow('不允许 DTD 或实体声明')
  })

  it('拒绝旧式二进制格式并明确提示另存为新格式', async () => {
    await expect(extractOfficeText(new Uint8Array(), 'doc')).rejects.toThrow('另存为')
    await expect(extractOfficeText(new Uint8Array(), 'ppt')).rejects.toThrow('另存为')
  })

  it('拒绝超过 Python 同等的 30MB Office 输入上限', async () => {
    await expect(extractOfficeText(new Uint8Array(30 * 1024 * 1024 + 1), 'xlsx')).rejects.toThrow('30MB')
  })

  it('将 Office 提取限制为 200000 字符', async () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet(Array.from({ length: 8 }, () => ['x'.repeat(32_000)]))
    XLSX.utils.book_append_sheet(workbook, sheet, '超长')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array
    expect((await extractOfficeText(bytes, 'xlsx')).length).toBe(200_000)
  })

  it('按 Unicode 字符而非 UTF-16 码元截断，避免切开末尾表情字符', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(Array.from({ length: 3_000 }, () => ['😀'.repeat(100)])), 'Unicode')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array
    const text = await extractOfficeText(bytes, 'xlsx')
    expect([...text]).toHaveLength(200_000)
    expect(text).not.toContain('\uFFFD')
  })

  it('每个表格最多读取 5000 行和 60 列', async () => {
    const workbook = XLSX.utils.book_new()
    const rows: unknown[][] = Array.from({ length: 4_999 }, (_, index) => [`行${index + 1}`])
    rows.push(['第5000行允许'])
    rows.push(['第5001行哨兵'])
    const lastAllowedRow: unknown[] = Array.from({ length: 61 }, (_, index) => index === 60 ? '第61列哨兵' : '')
    rows.push(lastAllowedRow)
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '边界')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array
    const text = await extractOfficeText(bytes, 'xlsx')
    expect(text).not.toContain('第5001行哨兵')
    expect(text).not.toContain('第61列哨兵')
  })

  it('对未知扩展名 fail closed，不把二进制文档误当 UTF-8 文本', async () => {
    await expect(extractOfficeText(Buffer.from([0, 1, 2]), 'bin')).rejects.toThrow('暂不支持')
  })
})
