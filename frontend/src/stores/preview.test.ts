import { describe, expect, it } from 'vitest'
import { isPreviewable, isTextExt } from './preview'

describe('文件预览类型判断', () => {
  it('允许未知扩展名通过文本 MIME 预览和编辑', () => {
    expect(isTextExt('custom', 'text/plain')).toBe(true)
    expect(isPreviewable('custom', 'text/plain')).toBe(true)
  })

  it('不把未知二进制文件误判为文本', () => {
    expect(isTextExt('custom', 'application/octet-stream')).toBe(false)
    expect(isPreviewable('custom', 'application/octet-stream')).toBe(false)
  })
})
