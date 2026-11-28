// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'
import { filesApi, pathFilesApi } from '@/services/api'
import TextViewer from '@/components/common/viewers/TextViewer.vue'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vue-codemirror', () => ({
  Codemirror: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    setup(props: { modelValue: string }, { emit }: { emit: (name: string, text: string) => void }) {
      return () => h('textarea', {
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
      })
    },
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('路径 Markdown 能进入编辑，保存到原工作区和相对路径后渲染新正文', async () => {
  const file = { directoryId: 7, relativePath: '笔记/计划.md' }
  vi.stubGlobal('fetch', vi.fn(async () => new Response('# 原始内容')))
  const save = vi.spyOn(pathFilesApi, 'saveText').mockResolvedValue({ ok: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(TextViewer, {
    blobUrl: 'blob:fixture', ext: 'md', fileKey: JSON.stringify(file), fileContext: { workspaceFile: file },
  }) })
  app.use(createPinia()).use(i18n).mount(host)
  try {
    await vi.waitFor(() => expect(host.querySelector('.tv-md')?.textContent).toContain('原始内容'))
    host.querySelector<HTMLButtonElement>('.tv-edit-toggle')!.click()
    await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull())
    const editor = host.querySelector('textarea')!
    editor.value = '# 修改后的内容'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    host.querySelector<HTMLButtonElement>('.tv-edit-save')!.click()
    await vi.waitFor(() => expect(host.querySelector('.tv-md')?.textContent).toContain('修改后的内容'))
    expect(save).toHaveBeenCalledExactlyOnceWith(file, '# 修改后的内容')
  } finally {
    app.unmount()
    host.remove()
  }
})

it('路径 Markdown 的相对图片通过授权目录解析并加载', async () => {
  const file = { directoryId: 7, relativePath: '笔记/计划.md' }
  const resolve = vi.spyOn(pathFilesApi, 'resolveRelative').mockResolvedValue([
    { path: '%E5%9B%BE.png', file: { relativePath: '笔记/图.png', name: '图.png' }, folder: null },
  ])
  const fetchMock = vi.fn(async (url: string) => new Response(url === 'blob:fixture' ? '![图片](图.png)' : '合成图片'))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:resolved-image'), revokeObjectURL: vi.fn() }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(TextViewer, {
    blobUrl: 'blob:fixture', ext: 'md', fileKey: JSON.stringify(file), fileContext: { workspaceFile: file },
  }) })
  app.use(createPinia()).use(i18n).mount(host)
  try {
    await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:resolved-image'))
    expect(resolve).toHaveBeenCalledWith(file, ['%E5%9B%BE.png'])
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('path='), expect.objectContaining({ credentials: 'include' }))
  } finally { app.unmount(); host.remove() }
})

it('路径 Markdown 相对文件链接打开解析后的文件预览', async () => {
  const file = { directoryId: 7, relativePath: '笔记/计划.md' }
  vi.spyOn(pathFilesApi, 'resolveRelative').mockResolvedValue([
    { path: 'next.md', file: { relativePath: '笔记/next.md', name: 'next.md' }, folder: null },
  ])
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[下一篇](next.md)')))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  const app = createApp({ render: () => h(TextViewer, {
    blobUrl: 'blob:fixture', ext: 'md', fileKey: JSON.stringify(file), fileContext: { workspaceFile: file },
  }) })
  app.use(pinia).use(i18n).mount(host)
  try {
    await vi.waitFor(() => expect(host.querySelector('a[href="next.md"]')).not.toBeNull())
    host.querySelector<HTMLAnchorElement>('a[href="next.md"]')!.click()
    const { usePreviewStore } = await import('@/stores/preview')
    await vi.waitFor(() => expect(usePreviewStore(pinia).windows[0]?.file.workspaceFile).toEqual({ directoryId: 7, relativePath: '笔记/next.md' }))
  } finally { app.unmount(); host.remove() }
})

it('路径 Markdown 相对文件夹链接使用路径目标导航', async () => {
  const file = { directoryId: 7, relativePath: '笔记/计划.md' }
  vi.spyOn(pathFilesApi, 'resolveRelative').mockResolvedValue([
    { path: '资料', file: null, folder: { relativePath: '笔记/资料', name: '资料' } },
  ])
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[资料](资料)')))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  const app = createApp({ render: () => h(TextViewer, {
    blobUrl: 'blob:fixture', ext: 'md', fileKey: JSON.stringify(file), fileContext: { workspaceFile: file },
  }) })
  app.use(pinia).use(i18n).mount(host)
  try {
    await vi.waitFor(() => expect(host.querySelector('a')).not.toBeNull())
    host.querySelector<HTMLAnchorElement>('a')!.click()
    const { useUiStore } = await import('@/stores/ui')
    await vi.waitFor(() => expect(useUiStore(pinia).pendingFileTarget).toEqual({ kind: 'folder', pathFile: { directoryId: 7, relativePath: '笔记/资料', directoryName: '' } }))
  } finally { app.unmount(); host.remove() }
})

it('不可预览的相对文件链接阻止浏览器跳转并按路径下载', async () => {
  const file = { directoryId: 7, relativePath: '笔记/计划.md' }
  vi.spyOn(pathFilesApi, 'resolveRelative').mockResolvedValue([
    { path: 'data.bin', file: { relativePath: '笔记/data.bin', name: 'data.bin' }, folder: null },
  ])
  const download = vi.spyOn(pathFilesApi, 'download').mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[下载](data.bin)')))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(TextViewer, {
    blobUrl: 'blob:fixture', ext: 'md', fileKey: JSON.stringify(file), fileContext: { workspaceFile: file },
  }) })
  app.use(createPinia()).use(i18n).mount(host)
  try {
    await vi.waitFor(() => expect(host.querySelector('a')).not.toBeNull())
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    host.querySelector<HTMLAnchorElement>('a')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith({ directoryId: 7, relativePath: '笔记/data.bin' }))
  } finally { app.unmount(); host.remove() }
})


it('路径预览直接解析相对链接，不再通过文件行号查找位置', async () => {
  const locate = vi.spyOn(filesApi, 'location').mockResolvedValue({ file: {} as never, folderPath: [], pathFile: { directoryId: 'personal', relativePath: '笔记/计划.md' } })
  const resolve = vi.spyOn(pathFilesApi, 'resolveRelative').mockResolvedValue([{ path: 'next.md', file: { relativePath: '笔记/next.md', name: 'next.md' }, folder: null }])
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[下一篇](next.md)')))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(TextViewer, { blobUrl: 'blob:fixture', ext: 'md', fileKey: '/personal/笔记/计划.md', fileContext: { filePath: '/personal/笔记/计划.md' } }) })
  app.use(createPinia()).use(i18n).mount(host)
  try {
    await vi.waitFor(() => expect(host.querySelector('a')).not.toBeNull())
    host.querySelector<HTMLAnchorElement>('a')!.click()
    await vi.waitFor(() => expect(locate).toHaveBeenCalledWith('/personal/笔记/计划.md'))
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({ directoryId: 'personal', relativePath: '笔记/计划.md' }, ['next.md']))
  } finally { app.unmount(); host.remove() }
})

it('路径预览直接解析相对图片', async () => {
  const locate = vi.spyOn(filesApi, 'location').mockResolvedValue({ file: {} as never, folderPath: [], pathFile: { directoryId: 'personal', relativePath: '笔记/计划.md' } })
  const resolve = vi.spyOn(pathFilesApi, 'resolveRelative').mockResolvedValue([{ path: 'image.png', file: { relativePath: '笔记/image.png', name: 'image.png' }, folder: null }])
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url === 'blob:fixture' ? '![图](image.png)' : '图片')))
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:path-image'), revokeObjectURL: vi.fn() }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(TextViewer, { blobUrl: 'blob:fixture', ext: 'md', fileKey: '/personal/笔记/计划.md', fileContext: { filePath: '/personal/笔记/计划.md' } }) })
  app.use(createPinia()).use(i18n).mount(host)
  try {
    await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:path-image'))
    expect(locate).toHaveBeenCalledWith('/personal/笔记/计划.md')
    expect(resolve).toHaveBeenCalledWith({ directoryId: 'personal', relativePath: '笔记/计划.md' }, ['image.png'])
  } finally { app.unmount(); host.remove() }
})
