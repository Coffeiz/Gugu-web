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

  it('无扩展名文件默认按文本预览（.gitignore/.env 等点文件与裸文件名）', () => {
    expect(isTextExt('', null)).toBe(true)
    expect(isTextExt(null, null)).toBe(true)
    expect(isTextExt('', 'application/octet-stream')).toBe(true)
    expect(isPreviewable('', null)).toBe(true)
    expect(isPreviewable(null, null)).toBe(true)
  })

  it('无扩展名但带媒体 MIME 的附件仍走媒体分支，不落到文本', () => {
    expect(isTextExt(null, 'image/png')).toBe(false)
    expect(isTextExt('', 'image/svg+xml')).toBe(false)
    expect(isTextExt('', 'video/mp4')).toBe(false)
    expect(isTextExt('', 'audio/mpeg')).toBe(false)
    // 聊天图片附件维持原状：image/* 无 ext 依旧不可预览（此前就没有预览入口）
    expect(isPreviewable(null, 'image/png')).toBe(false)
  })

  it('已知二进制扩展名不因空 MIME 误判为文本', () => {
    expect(isTextExt('EXE', null)).toBe(false)
    expect(isTextExt('PDF', null)).toBe(false)
    expect(isPreviewable('PDF', null)).toBe(true)  // PDF 走白名单，但不是文本
    expect(isTextExt('PDF', null)).toBe(false)
  })
})
