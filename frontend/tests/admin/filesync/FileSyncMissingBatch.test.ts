// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import FileSyncMissingBatch from '@/components/filesync/FileSyncMissingBatch.vue'
import type { FileSyncConflictStatus } from '@/api/filesync'

const mocks = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn(), confirm: vi.fn() }))
vi.mock('@/api/filesync', () => ({ filesyncAdminApi: { previewMissing: mocks.preview, applyMissing: mocks.apply } }))
vi.mock('@/stores/admin', () => ({ useAdminStore: () => ({ authFetch: vi.fn() }) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: mocks.confirm }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
let app: ReturnType<typeof createApp>
let host: HTMLDivElement
function mount() {
  host = document.createElement('div'); document.body.append(host)
  app = createApp(FileSyncMissingBatch, { conflicts: [
    { id: 1, bindingId: 7, hasLocal: false },
    { id: 2, bindingId: 9, hasLocal: true },
  ] as FileSyncConflictStatus[] })
  app.mount(host)
}
afterEach(() => { app?.unmount(); host?.remove(); vi.resetAllMocks() })
it('取消预览确认不会提交删除请求', async () => {
  mocks.preview.mockResolvedValue({ bindingId: 7, rootFingerprint: 'root', items: [{ conflictId: 1 }] })
  mocks.confirm.mockResolvedValue(false)
  mount(); (host.querySelector('button') as HTMLButtonElement).click(); await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce()); await nextTick()
  expect(mocks.preview).toHaveBeenCalledWith(expect.anything(), 7)
  expect(mocks.confirm).toHaveBeenCalledOnce()
  expect(mocks.apply).not.toHaveBeenCalled()
})
it('确认后只提交预览快照并按25条分批，呈现跳过项', async () => {
  const items = Array.from({ length: 26 }, (_, index) => ({ conflictId: index + 1 }))
  mocks.preview.mockResolvedValue({ bindingId: 7, rootFingerprint: 'root', items })
  mocks.confirm.mockResolvedValue(true)
  mocks.apply.mockImplementation(async (_fetch, _preview, batch) => ({ results: batch.map((item: { conflictId: number }) => ({
    id: item.conflictId, status: item.conflictId === 26 ? 'skipped' : 'completed', reason: '文件已恢复',
  })) }))
  mount(); (host.querySelector('button') as HTMLButtonElement).click(); await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2)); await nextTick()
  expect(mocks.apply).toHaveBeenCalledTimes(2)
  expect(mocks.apply.mock.calls[0][2]).toHaveLength(25)
  expect(mocks.apply.mock.calls[1][2]).toHaveLength(1)
  expect(host.textContent).toContain('文件已恢复')
})
