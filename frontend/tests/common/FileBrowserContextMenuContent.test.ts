import { createApp, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { i18n } from '@/i18n'
import FileBrowserContextMenuContent from '@/components/common/file-browser/FileBrowserContextMenuContent.vue'

describe('文件库右键菜单归档操作', () => {
  function renderMenu(props: Record<string, unknown>) {
    const actions: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(FileBrowserContextMenuContent, {
        ...props,
        onAction: (action: string) => actions.push(action),
      }),
    })
    app.use(i18n)
    app.mount(host)
    return { app, host, actions }
  }

  it('右键压缩包显示解压入口并分发对应动作', () => {
    const menu = renderMenu({ type: 'file', canExtractArchive: true })
    const button = menu.host.querySelector('[data-testid="context-extract-archive"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    button.click()
    expect(menu.actions).toEqual(['extract-archive'])
    menu.app.unmount()
    menu.host.remove()
  })

  it('右键多选项显示压缩入口并分发对应动作', () => {
    const menu = renderMenu({ type: 'multi-file', canCompressSelection: true })
    const button = menu.host.querySelector('[data-testid="context-compress-selection"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    button.click()
    expect(menu.actions).toEqual(['compress-selection'])
    menu.app.unmount()
    menu.host.remove()
  })

  it('文件菜单不再提供独立后缀入口，后缀与普通重命名一同编辑', () => {
    const menu = renderMenu({ type: 'file' })
    expect(menu.host.querySelector('[data-testid="context-change-extension"]')).toBeNull()
    menu.app.unmount()
    menu.host.remove()
  })

  it('单个已选文件的右键菜单也提供压缩入口', () => {
    const menu = renderMenu({ type: 'file', canCompressSelection: true })
    expect(menu.host.querySelector('[data-testid="context-compress-selection"]')).not.toBeNull()
    menu.app.unmount()
    menu.host.remove()
  })

  it('已选文件夹的右键菜单提供压缩入口', () => {
    const menu = renderMenu({ type: 'folder', canCompressSelection: true })
    expect(menu.host.querySelector('[data-testid="context-compress-selection"]')).not.toBeNull()
    menu.app.unmount()
    menu.host.remove()
  })

  it('已选中的压缩包进入多选菜单时仍保留解压入口', () => {
    const menu = renderMenu({ type: 'multi-file', canExtractArchive: true, canCompressSelection: true })
    expect(menu.host.querySelector('[data-testid="context-extract-archive"]')).not.toBeNull()
    expect(menu.host.querySelector('[data-testid="context-compress-selection"]')).not.toBeNull()
    menu.app.unmount()
    menu.host.remove()
  })

  it('未声明为可压缩的菜单上下文不显示归档入口', () => {
    const menu = renderMenu({ type: 'file', canExtractArchive: false, canCompressSelection: false })
    expect(menu.host.querySelector('[data-testid="context-extract-archive"]')).toBeNull()
    expect(menu.host.querySelector('[data-testid="context-compress-selection"]')).toBeNull()
    menu.app.unmount()
    menu.host.remove()
  })
})
