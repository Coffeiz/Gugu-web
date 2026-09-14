import { createApp, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { i18n } from '@/i18n'
import FileSelectionToolbar from '@/components/common/file-browser/FileSelectionToolbar.vue'

describe('文件库选择工具栏归档操作', () => {
  it('单选可解压压缩包时同时保留压缩并提供解压入口', () => {
    const actions: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(FileSelectionToolbar, {
        fileCount: 1,
        canExtractArchive: true,
        onArchive: () => actions.push('compress'),
        onExtract: () => actions.push('extract'),
      }),
    })
    app.use(i18n)
    app.mount(host)

    const extract = host.querySelector('[data-testid="selection-extract-archive"]') as HTMLButtonElement
    const compress = host.querySelector('[data-testid="selection-compress"]') as HTMLButtonElement
    expect(extract).not.toBeNull()
    expect(compress).not.toBeNull()
    extract.click()
    compress.click()
    expect(actions).toEqual(['extract', 'compress'])

    app.unmount()
    host.remove()
  })

  it('普通选择不显示解压入口', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(FileSelectionToolbar, { fileCount: 1 }) })
    app.use(i18n)
    app.mount(host)

    expect(host.querySelector('[data-testid="selection-extract-archive"]')).toBeNull()

    app.unmount()
    host.remove()
  })
})
