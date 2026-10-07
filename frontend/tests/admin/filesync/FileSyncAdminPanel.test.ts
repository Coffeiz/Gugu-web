// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import FileSyncAdminPanel from '@/components/filesync/FileSyncAdminPanel.vue'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  runs: vi.fn(),
  invalidate: vi.fn(),
  startEvents: vi.fn(),
  stopEvents: vi.fn(),
}))

vi.mock('@/api/filesync', () => ({
  filesyncAdminApi: { status: mocks.status, runs: mocks.runs },
}))

vi.mock('@/composables/filesync/useFileSyncAdminEvents', () => ({
  useFileSyncAdminEvents: (_authFetch: unknown, onInvalidate: () => void) => {
    mocks.invalidate.mockImplementation(onInvalidate)
    return { start: mocks.startEvents, stop: mocks.stopEvents }
  },
}))

vi.mock('@/stores/admin', () => ({
  useAdminStore: () => ({ authFetch: vi.fn() }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@/composables/core/useConfirmDialog', () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/components/common/controls/ActionButton.vue', () => ({
  default: { inheritAttrs: false, template: '<button v-bind="$attrs"><slot /></button>' },
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
  mocks.runs.mockReset()
  mocks.invalidate.mockReset()
  mocks.startEvents.mockReset()
  mocks.stopEvents.mockReset()
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
    mocks.runs.mockResolvedValue([{
      id: 'run-1', bindingId: 1, action: 'repair', allowDelete: false,
      status: 'running', stage: 'scanning', scannedCount: 42,
      resultCounts: { created: 2, updated: 1, moved: 0, deleted: 0, skipped: 0, conflicts: 0, failed: 0 },
      errorCode: null, revision: 3, cancelRequested: false,
      createdAt: null, startedAt: null, finishedAt: null,
    }])

    const root = mountPanel()
    await flushUi()

    const rows = root.querySelectorAll('.fs-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('filesyncAdmin.manualReconcileNeeded')
    expect(rows[0].textContent).toContain('filesyncAdmin.reconcile')
    expect(rows[0].textContent).toContain('watcher_error')
    const run = root.querySelector('.fs-run')
    expect(run?.textContent).toContain('filesyncUser.status.running')
    expect(run?.textContent).toContain('filesyncUser.scanned')
    expect(mocks.startEvents).toHaveBeenCalledOnce()
  })

  it('收到任务失效通知后重新读取 Admin 权威状态与任务进度', async () => {
    mocks.status.mockResolvedValue({
      featureEnabled: true, storageBackend: 'local', supported: true,
      workspaceShellSupported: true, ignoredBindingCount: 0, bindings: [], conflicts: [],
      failures: [], totals: { bindings: 0, journals: 0, pendingJournals: 0,
        failedJournals: 0, rejectedJournals: 0, pendingConflicts: 0, pendingOutbox: 0 },
      generatedAt: '2026-10-07T00:00:00Z',
    })
    mocks.runs.mockResolvedValue([])
    mountPanel()
    await flushUi()
    mocks.status.mockClear()
    mocks.runs.mockClear()

    mocks.invalidate()
    await flushUi()

    expect(mocks.status).toHaveBeenCalledOnce()
    expect(mocks.runs).toHaveBeenCalledOnce()
  })
})
