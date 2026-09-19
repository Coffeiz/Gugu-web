import { describe, expect, it } from 'vitest'
import { normalizeEditableExtension } from './fileTypes'

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
