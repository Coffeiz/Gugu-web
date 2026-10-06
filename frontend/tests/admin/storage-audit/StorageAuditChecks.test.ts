// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import StorageAuditChecks from '@/views/Admin/StorageAudit/components/StorageAuditChecks.vue'

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  confirmDialog: vi.fn(),
}))

vi.mock('@/stores/admin', () => ({
  useAdminStore: () => ({ authFetch: mocks.authFetch }),
}))

vi.mock('@/composables/core/useConfirmDialog', () => ({
  confirmDialog: mocks.confirmDialog,
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@/components/common/controls/ActionButton.vue', () => ({
  default: { inheritAttrs: false, template: '<button v-bind="$attrs"><slot /></button>' },
}))

vi.mock('@/components/common/controls/Checkbox.vue', () => ({
  default: { template: '<label><slot /></label>' },
}))

vi.mock('@/components/filesync/FileSyncAdminPanel.vue', () => ({
  default: { template: '<div />' },
}))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

function mountChecks() {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(StorageAuditChecks)
  app.component('Icon', { template: '<span />' })
  app.mount(host)
  return host
}

async function flushUi() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => data }
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
  mocks.authFetch.mockReset()
  mocks.confirmDialog.mockReset()
})

describe('Admin 存储对账幽灵记录处理', () => {
  it('提供逐条和批量移除入口，并提交确认过的记录 ID 后刷新对账结果', async () => {
    const report = {
      backend: 'local', location: 'test-storage', db_file_rows: 2, storage_objects: 1,
      matched: 1, ghost_count: 1, orphan_count: 0, misplaced_count: 0,
      ghosts: [{ id: 41, name: 'missing.png', space: 'personal', project: null, deleted: false, storage_key: 'synthetic/个人文件/missing.png' }],
      orphans: [], misplaced_files: [], truncated: false,
    }
    const refreshed = { ...report, db_file_rows: 1, ghost_count: 0, ghosts: [] }
    mocks.authFetch
      .mockResolvedValueOnce(jsonResponse(report))
      .mockResolvedValueOnce(jsonResponse({ done: [41], failed: [] }))
      .mockResolvedValueOnce(jsonResponse(refreshed))
    mocks.confirmDialog.mockResolvedValue(true)

    const root = mountChecks()
    const scanButton = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('storageAudit.scan'))
    scanButton?.click()
    await flushUi()

    const ghostActions = [...root.querySelectorAll('.recon-block-title .recon-bulk button, .recon-row-acts button')]
    expect(ghostActions).toHaveLength(2)
    ghostActions[0].click()
    await flushUi()

    expect(mocks.confirmDialog).toHaveBeenCalledOnce()
    expect(mocks.authFetch).toHaveBeenNthCalledWith(2,
      '/api/v1/admin/config/reconcile-storage/ghosts/repair',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ file_ids: [41], confirm: true }) }),
    )
    expect(mocks.authFetch).toHaveBeenNthCalledWith(3, '/api/v1/admin/config/reconcile-storage')
    expect(root.textContent).not.toContain('missing.png')
    expect(root.textContent).toContain('storageAuditExtra.ghostRepairResult')
  })

  it('超过单批上限时分批清理完整幽灵 ID 列表，并在批次间显示真实进度', async () => {
    const ghostIds = Array.from({ length: 601 }, (_, index) => index + 1)
    const report = {
      backend: 'local', location: 'test-storage', db_file_rows: 601, storage_objects: 0,
      matched: 0, ghost_count: ghostIds.length, ghost_ids: ghostIds, orphan_count: 0, misplaced_count: 0,
      ghosts: [{ id: 1, name: 'missing.png', space: 'personal', project: null, deleted: false, storage_key: 'synthetic/个人文件/missing.png' }],
      orphans: [], misplaced_files: [], truncated: true,
    }
    const refreshed = { ...report, ghost_count: 0, ghost_ids: [], ghosts: [] }
    const submittedBatches: number[][] = []
    let postCount = 0
    let releaseSecondBatch: ((response: ReturnType<typeof jsonResponse>) => void) | undefined
    mocks.authFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/v1/admin/config/reconcile-storage') {
        return Promise.resolve(jsonResponse(postCount ? refreshed : report))
      }
      postCount += 1
      const body = JSON.parse(String(init?.body)) as { file_ids: number[] }
      submittedBatches.push(body.file_ids)
      if (postCount === 2) {
        return new Promise((resolve) => { releaseSecondBatch = resolve })
      }
      return Promise.resolve(jsonResponse({ done: body.file_ids, failed: [] }))
    })
    mocks.confirmDialog.mockResolvedValue(true)

    const root = mountChecks()
    const scanButton = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('storageAudit.scan'))
    scanButton?.click()
    await flushUi()

    const bulkButton = root.querySelector('.recon-block-title .recon-bulk button')
    bulkButton?.click()
    await flushUi()

    const progress = root.querySelector('[role="progressbar"]')
    expect(progress?.getAttribute('aria-valuemax')).toBe('601')
    expect(progress?.getAttribute('aria-valuenow')).toBe('300')
    expect(submittedBatches).toHaveLength(2)
    expect(submittedBatches[0]).toEqual(ghostIds.slice(0, 300))
    expect(submittedBatches[1]).toEqual(ghostIds.slice(300, 600))

    releaseSecondBatch?.(jsonResponse({ done: submittedBatches[1], failed: [] }))
    await flushUi()

    expect(submittedBatches).toHaveLength(3)
    expect(submittedBatches[2]).toEqual([601])
    expect(root.querySelector('[role="progressbar"]')).toBeNull()
    expect(root.textContent).toContain('storageAuditExtra.ghostRepairResult')
  })

  it('将权限失败项单独列出并保留重试入口，避免批量错误被塞进一整段提示', async () => {
    const key = 'synthetic/个人文件/locked.txt'
    const report = {
      backend: 'local', location: 'test-storage', db_file_rows: 0, storage_objects: 1,
      matched: 0, ghost_count: 0, orphan_count: 1, misplaced_count: 0,
      ghosts: [], orphans: [key], misplaced_files: [], truncated: false,
    }
    const emptyReport = { ...report, storage_objects: 0, orphan_count: 0, orphans: [] }
    mocks.authFetch
      .mockResolvedValueOnce(jsonResponse(report))
      .mockResolvedValueOnce(jsonResponse({ done: 0, failed: [{ key, error: '权限不足；请检查 ACL 后重试' }] }))
      .mockResolvedValueOnce(jsonResponse(report))
      .mockResolvedValueOnce(jsonResponse({ done: 1, failed: [] }))
      .mockResolvedValueOnce(jsonResponse(emptyReport))
    mocks.confirmDialog.mockResolvedValue(true)

    const root = mountChecks()
    const scanButton = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('storageAudit.scan'))
    scanButton?.click()
    await flushUi()

    const deleteButton = [...root.querySelectorAll('.recon-block button')]
      .find(button => button.textContent?.includes('storageAuditExtra.delete'))
    deleteButton?.click()
    await flushUi()

    expect(root.textContent).toContain('storageAuditExtra.failedItems')
    expect(root.textContent).toContain('权限不足；请检查 ACL 后重试')
    const retryButton = root.querySelector('.repair-failures .recon-bulk button')
    retryButton?.click()
    await flushUi()

    expect(mocks.authFetch).toHaveBeenNthCalledWith(4,
      '/api/v1/admin/config/reconcile-storage/repair',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'delete', keys: [key], confirm: true }) }),
    )
    expect(root.textContent).not.toContain('storageAuditExtra.failedItems')
  })
})
