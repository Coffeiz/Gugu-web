// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'
import { filesApi } from '@/services/api'
import FileInfoPopup from '@/components/common/file-browser/FileInfoPopup.vue'

it('文件信息按路径定位结果显示目录', async () => {
  const location = vi.spyOn(filesApi, 'location').mockResolvedValue({
    file: { id: 17, displayName: '计划', ext: 'md', space: 'personal' } as never,
    pathFile: { directoryId: 'personal', relativePath: '资料/计划.md' },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(FileInfoPopup, { show: true, file: { id: 17, displayName: '计划', ext: 'md', space: 'personal' } }) })
  app.use(createPinia()).use(i18n).mount(host)
  try { await vi.waitFor(() => expect(document.body.textContent).toContain('资料')) }
  finally { app.unmount(); host.remove(); location.mockRestore() }
})
