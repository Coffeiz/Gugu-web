// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import FileObjectReconciliation from '@/views/Admin/StorageAudit/components/FileObjectReconciliation.vue'
import DirectoryReconciliation from '@/views/Admin/StorageAudit/components/DirectoryReconciliation.vue'

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  confirmDialog: vi.fn(),
}))

vi.mock('@/stores/admin', () => ({ useAdminStore: () => ({ authFetch: mocks.authFetch }) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: mocks.confirmDialog }))
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})
vi.mock('@/components/common/controls/ActionButton.vue', () => ({
  default: { inheritAttrs: false, template: '<button v-bind="$attrs"><slot /></button>' },
}))
vi.mock('@/components/common/controls/Checkbox.vue', () => ({
  default: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<label><input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)"><slot /></label>',
  },
}))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

function mount(component: typeof FileObjectReconciliation | typeof DirectoryReconciliation) {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(component)
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
  return { ok: true, status: 200, json: async () => data }
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
  mocks.authFetch.mockReset()
  mocks.confirmDialog.mockReset()
})

describe('Admin 存储对账分区', () => {
  it('一次文件扫描分别展示幽灵记录与孤儿文件，不在文件区重复展示错位文件', async () => {
    mocks.authFetch.mockResolvedValue(jsonResponse({
      backend: 'local', location: 'test', db_file_rows: 8, storage_objects: 7, matched: 6,
      ghost_count: 1, ghost_ids: [17], ghosts: [{ id: 17, name: 'lost.png', space: 'personal', project: null, deleted: false, storage_key: 'u/lost.png' }],
      orphan_count: 1, orphans: ['u/orphan.png'], misplaced_count: 1,
      misplaced_files: [{ file_id: 23, display_name: 'moved.png', current_key: 'old.png', expected_key: 'new.png' }],
      truncated: false,
    }))

    const root = mount(FileObjectReconciliation)
    root.querySelector('.sa-card-head button')?.click()
    await flushUi()

    expect(mocks.authFetch).toHaveBeenCalledOnce()
    expect(mocks.authFetch).toHaveBeenCalledWith('/api/v1/admin/config/reconcile-storage')
    expect(root.querySelector('section.sa-card.file-audit-group')).not.toBeNull()
    expect(root.querySelectorAll('.fd-section')).toHaveLength(2)
    expect(root.querySelectorAll('.file-audit-grid > .fd-section')).toHaveLength(2)
    expect(root.textContent).toContain('storageAuditExtra.ghostRecords')
    expect(root.textContent).toContain('storageAuditExtra.orphanFiles')
    expect(root.textContent).toContain('u/orphan.png')
    expect(root.textContent).not.toContain('moved.png')
  })

  it('文件对账健康状态使用文件语义，不复用目录一致状态', async () => {
    mocks.authFetch.mockResolvedValue(jsonResponse({
      backend: 'local', location: 'test', db_file_rows: 2, storage_objects: 2, matched: 2,
      ghost_count: 0, ghost_ids: [], ghosts: [], orphan_count: 0, orphans: [], truncated: false,
    }))

    const root = mount(FileObjectReconciliation)
    root.querySelector('.sa-card-head button')?.click()
    await flushUi()

    expect(root.textContent).toContain('storageAuditExtra.noGhostRecords')
    expect(root.textContent).toContain('storageAuditExtra.noOrphanFiles')
    expect(root.textContent).toContain('storageAuditExtra.filesHealthy')
    expect(root.textContent).not.toContain('storageAuditUi.healthy')
  })

  it('目录对账独立扫描，并且错位文件仅通过目录修复接口迁移', async () => {
    mocks.authFetch
      .mockResolvedValueOnce(jsonResponse({
        missing_dirs: [], orphan_dirs: [],
        misplaced_files: [{ file_id: 23, display_name: 'moved.png', current_key: 'old.png', expected_key: 'new.png' }],
        scanned_folders: 3, created: 0, removed: 0, relocated: 0, healthy: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        missing_dirs: [], orphan_dirs: [], misplaced_files: [],
        scanned_folders: 3, created: 0, removed: 0, relocated: 1, healthy: true,
      }))

    const root = mount(DirectoryReconciliation)
    root.querySelector('.sa-card-head button')?.click()
    await flushUi()
    expect(mocks.authFetch).toHaveBeenNthCalledWith(1, '/api/v1/admin/folder-doctor/scan')
    expect(root.textContent).toContain('moved.png')

    const checkbox = root.querySelector('input[type="checkbox"]') as HTMLInputElement
    checkbox.click()
    await flushUi()
    root.querySelector('.fd-actions button')?.click()
    await flushUi()

    expect(mocks.authFetch).toHaveBeenNthCalledWith(2, '/api/v1/admin/folder-doctor/repair', {
      method: 'POST',
      body: JSON.stringify({ user_id: null, remove_orphans: false, relocate_files: true }),
    })
    expect(root.textContent).toContain('storageAuditExtra.lastFix')
    expect(mocks.authFetch.mock.calls.some(([url]) => String(url).includes('reconcile-storage/repair'))).toBe(false)
  })

  it('取消孤儿物理文件永久删除确认时不发送修复请求', async () => {
    mocks.authFetch.mockResolvedValue(jsonResponse({
      backend: 'local', location: 'test', db_file_rows: 1, storage_objects: 1, matched: 0,
      ghost_count: 0, ghost_ids: [], ghosts: [], orphan_count: 1, orphans: ['u/orphan.png'], truncated: false,
    }))
    mocks.confirmDialog.mockResolvedValue(false)

    const root = mount(FileObjectReconciliation)
    root.querySelector('.sa-card-head button')?.click()
    await flushUi()
    root.querySelector('.orphan-file-item .recon-act-del')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(mocks.confirmDialog).toHaveBeenCalledOnce()
    expect(mocks.authFetch).toHaveBeenCalledOnce()
  })
})
