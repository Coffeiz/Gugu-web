// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'
import { pathFilesApi } from '@/services/api'
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
