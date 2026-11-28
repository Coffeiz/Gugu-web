import { describe, expect, it } from 'vitest'
import {
  RiBlenderLine, RiCss3Line, RiFileExcel2Line, RiFilePdf2Line, RiFilePpt2Line, RiFileWord2Line,
  RiHtml5Line, RiJavaLine, RiJavascriptLine, RiMarkdownLine, RiPhpLine, RiReactjsLine, RiVuejsLine,
} from '@remixicon/vue'
import { fileListIcon, normalizeEditableExtension } from '@/utils/fileTypes'

describe('文件列表图标', () => {
  it.each([
    ['vue', RiVuejsLine], ['BLEND', RiBlenderLine],
    ['html', RiHtml5Line], ['HTM', RiHtml5Line], ['css', RiCss3Line],
    ['js', RiJavascriptLine], ['mjs', RiJavascriptLine], ['cjs', RiJavascriptLine],
    ['php', RiPhpLine], ['java', RiJavaLine], ['tsx', RiReactjsLine],
  ] as const)('%s 使用专属图标', (extension, icon) => {
    expect(fileListIcon(extension)).toBe(icon)
  })

  it('Markdown 与 Office/PDF 文件使用对应的 Remix 文件图标', () => {
    expect(fileListIcon('md')).toBe(RiMarkdownLine)
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
