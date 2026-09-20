// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isPreviewable, isTextExt } from './preview'
import { isPreviewReloadRequested, usePreviewStore } from './preview'

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

describe('预览窗口复用', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800 })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('强刷标记只在首次消费或计数变化时触发', () => {
    expect(isPreviewReloadRequested(1)).toBe(true)
    expect(isPreviewReloadRequested(1, 1)).toBe(false)
    expect(isPreviewReloadRequested(2, 1)).toBe(true)
    expect(isPreviewReloadRequested(0, 1)).toBe(true)
  })

  it('聊天文件再次打开时更新同 ID 窗口并递增强制重载标记', () => {
    const store = usePreviewStore()
    store.open({ id: 321, ext: 'TXT', displayName: '旧内容' })

    store.open({ id: 321, ext: 'TXT', displayName: '最新内容' }, null, true)

    expect(store.windows).toHaveLength(1)
    expect(store.windows[0].file.displayName).toBe('最新内容')
    expect(store.windows[0].reloadToken).toBe(1)

    store.open({ id: 321, ext: 'TXT', displayName: '再打开' }, null, true)
    expect(store.windows[0].reloadToken).toBe(2)

    // 普通入口只更新元数据，token 不变；watch 不应继续把历史强刷当成新请求。
    store.open({ id: 321, ext: 'TXT', displayName: '普通更新' })
    expect(store.windows[0].file.displayName).toBe('普通更新')
    expect(store.windows[0].reloadToken).toBe(2)
  })

  it('普通入口复用窗口时不强制绕过缓存', () => {
    const store = usePreviewStore()
    store.open({ id: 654, ext: 'TXT', displayName: '旧名称' })

    store.open({ id: 654, ext: 'TXT', displayName: '新名称' })

    expect(store.windows).toHaveLength(1)
    expect(store.windows[0].file.displayName).toBe('新名称')
    expect(store.windows[0].reloadToken).toBe(0)
  })
})
