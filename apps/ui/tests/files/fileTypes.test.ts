import { describe, expect, it } from 'vitest'
import {
  RiFileExcel2Line, RiFilePdf2Line, RiFilePpt2Line, RiFileTextLine, RiFileWord2Line, RiGlobalLine,
} from '@remixicon/vue'
import { fileListIcon, normalizeEditableExtension } from '@/utils/fileTypes'

describe('文件列表图标', () => {
  it('HTML 文件使用地球图标，其他代码文件继续使用代码图标', () => {
    expect(fileListIcon('html')).toBe(RiGlobalLine)
    expect(fileListIcon('HTM')).toBe(RiGlobalLine)
    expect(fileListIcon('css')).not.toBe(RiGlobalLine)
  })

  it('Markdown 与 Office/PDF 文件使用对应的 Remix 文件图标', () => {
    expect(fileListIcon('md')).toBe(RiFileTextLine)
    expect(fileListIcon('PDF')).toBe(RiFilePdf2Line)
    expect(fileListIcon('docx')).toBe(RiFileWord2Line)
    expect(fileListIcon('pptx')).toBe(RiFilePpt2Line)
    expect(fileListIcon('xlsx')).toBe(RiFileExcel2Line)
  })
})

describe('文件后缀输入标准化', () => {
  it('接受字母数字、下划线与连字符并转成大写', () => {
    expect(normalizeEditableExtension(' md-2_x ')).toBe('MD-2_X')
  })

  it('仅对无后缀文件允许空值，并拒绝格式不合法或保留值', () => {
    expect(normalizeEditableExtension('')).toBe('')
    expect(normalizeEditableExtension('a.b')).toBeNull()
    expect(normalizeEditableExtension('FILE')).toBeNull()
    expect(normalizeEditableExtension('12345678901')).toBeNull()
  })
})
