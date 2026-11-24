import { describe, expect, it } from 'vitest'
import { isRelativeFileLink } from '@/utils/fileLinks'

describe('相对文件链接识别', () => {
  it('接受相对路径，排除外链、协议和锚点', () => {
    expect(isRelativeFileLink('https://example.test/a.md')).toBe(false)
    expect(isRelativeFileLink('#section')).toBe(false)
    expect(isRelativeFileLink('gugu://open-object/file/1')).toBe(false)
    expect(isRelativeFileLink('../guide.md')).toBe(true)
    expect(isRelativeFileLink('./目录/封面.png')).toBe(true)
    expect(isRelativeFileLink('%E0%A4%A')).toBe(false)
  })
})
