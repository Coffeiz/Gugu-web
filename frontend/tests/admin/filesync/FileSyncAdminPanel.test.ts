// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import FileSyncAdminPanel from '@/components/filesync/FileSyncAdminPanel.vue'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
}))

vi.mock('@/api/filesync', () => ({
  filesyncAdminApi: { status: mocks.status },
}))

vi.mock('@/stores/admin', () => ({
  useAdminStore: () => ({ authFetch: vi.fn() }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@/composables/core/useConfirmDialog', () => ({
  confirmDialog: vi.fn(),
}))

vi.mock('@/components/common/controls/ActionButton.vue', () => ({
  default: { template: '<button><slot /></button>' },
}))

vi.mock('@/components/common/controls/ToggleSwitch.vue', () => ({
  default: { template: '<button><slot /></button>' },
}))

vi.mock('@/components/common/icons/Icon.vue', () => ({
  default: { template: '<span />' },
}))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

function mountPanel() {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(FileSyncAdminPanel)
  app.mount(host)
  return host
}

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
  mocks.status.mockReset()
})

describe('FileSyncAdminPanel 监听缺口提示', () => {
  it('默认异常筛选显示待手动核对绑定及恢复入口', async () => {
    mocks.status.mockResolvedValue({
      featureEnabled: true,
      storageBackend: 'local',
      supported: true,
      workspaceShellSupported: true,
      ignoredBindingCount: 0,
      bindings: [
        {
          id: 1, userId: 'synthetic-user', source: 'local_directory', mode: 'bidirectional',
          status: 'active', protocolVersion: 1, rootPath: '.', revision: 0,
          watcherStatus: 'degraded', needsReconcile: true, healthRevision: 1, gapRevision: 1,
          healthErrorCode: 'watcher_error', lastReconciledAt: null, updatedAt: null,
          pendingJournal: 0, failedJournal: 0, rejectedJournal: 0, pendingConflicts: 0,
        },
        {
          id: 2, userId: 'synthetic-user', source: 'local_directory', mode: 'bidirectional',
          status: 'active', protocolVersion: 1, rootPath: '.', revision: 0,
          watcherStatus: 'ready', needsReconcile: false, healthRevision: 1, gapRevision: 0,
          healthErrorCode: null, lastReconciledAt: null, updatedAt: null,
          pendingJournal: 0, failedJournal: 0, rejectedJournal: 0, pendingConflicts: 0,
        },
      ],
      conflicts: [],
      failures: [],
      totals: {
        bindings: 2, journals: 0, pendingJournals: 0, failedJournals: 0,
        rejectedJournals: 0, pendingConflicts: 0, pendingOutbox: 0,
      },
      generatedAt: '2026-10-07T00:00:00Z',
    })

    const root = mountPanel()
    await flushUi()

    const rows = root.querySelectorAll('.fs-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('filesyncAdmin.manualReconcileNeeded')
    expect(rows[0].textContent).toContain('filesyncAdmin.reconcile')
    expect(rows[0].textContent).toContain('watcher_error')
  })
})
