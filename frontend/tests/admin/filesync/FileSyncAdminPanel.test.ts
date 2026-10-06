// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import FileSyncAdminPanel from '@/components/filesync/FileSyncAdminPanel.vue'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  dryRun: vi.fn(),
  reconcile: vi.fn(),
  run: vi.fn(),
  confirmDialog: vi.fn(),
}))

vi.mock('@/api/filesync', () => ({
  filesyncAdminApi: {
    status: mocks.status,
    dryRun: mocks.dryRun,
    reconcile: mocks.reconcile,
    run: mocks.run,
  },
}))

vi.mock('@/stores/admin', () => ({
  useAdminStore: () => ({ authFetch: vi.fn() }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, ...args: unknown[]) => `${key} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`,
    }),
  }
})

vi.mock('@/composables/core/useConfirmDialog', () => ({
  confirmDialog: mocks.confirmDialog,
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
let originalScrollIntoView: HTMLElement['scrollIntoView'] | undefined

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
  vi.useRealTimers()
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
  mocks.status.mockReset()
  mocks.dryRun.mockReset()
  mocks.reconcile.mockReset()
  mocks.run.mockReset()
  mocks.confirmDialog.mockReset()
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  originalScrollIntoView = undefined
})

function makeStatus(reconcileRuns: Array<Record<string, unknown>> = []) {
  return {
    featureEnabled: true,
    backgroundReconcileEnabled: true,
    storageBackend: 'local',
    supported: true,
    workspaceShellSupported: true,
    ignoredBindingCount: 0,
    bindings: [{
      id: 1, userId: 'synthetic-user', source: 'local_directory', mode: 'bidirectional',
      status: 'active', protocolVersion: 1, rootPath: '.', revision: 0,
      watcherStatus: 'degraded', needsReconcile: true, healthRevision: 1, gapRevision: 1,
      healthErrorCode: 'watcher_error', lastReconciledAt: null, updatedAt: null,
      pendingJournal: 0, failedJournal: 0, rejectedJournal: 0, pendingConflicts: 0,
    }],
    conflicts: [],
    failures: [],
    reconcileRuns,
    userScanStates: [],
    totals: {
      bindings: 1, journals: 0, pendingJournals: 0, failedJournals: 0,
      rejectedJournals: 0, pendingConflicts: 0, pendingOutbox: 0,
    },
    generatedAt: '2026-10-07T00:00:00Z',
  }
}

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
      reconcileRuns: [],
      userScanStates: [],
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

describe('FileSyncAdminPanel 对账任务反馈', () => {
  it('预览异步完成后更新计数并把任务结果滚动到视野内', async () => {
    const queued = {
      id: 'synthetic-run-1', bindingId: 1, mode: 'integrity_full', reason: 'manual',
      status: 'queued', stage: 'claiming', dryRun: true, progressCurrent: 0,
      progressTotal: null, resultCounts: {}, errorCode: null,
    }
    const completed = {
      ...queued, status: 'succeeded', stage: 'finished',
      resultCounts: { scanned: 12, created: 2, updated: 1, rejected: 0, conflicts: 0 },
    }
    mocks.status.mockResolvedValue(makeStatus())
    mocks.dryRun.mockResolvedValue(queued)
    mocks.run.mockResolvedValue(completed)
    vi.useFakeTimers()
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView

    const root = mountPanel()
    await flushUi()
    root.querySelector<HTMLButtonElement>('.fs-actions button')?.click()
    await flushUi()

    expect(root.querySelector('.fs-result')?.textContent).toContain('filesyncAdmin.dryRunState')
    expect(scrollIntoView).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1500)
    await flushUi()

    expect(root.querySelector('.fs-result')?.textContent).toContain('filesyncAdmin.dryRunResult')
    expect(root.querySelector('.fs-result')?.textContent).toContain('12')
    expect(root.querySelector('.fs-result')?.textContent).toContain('2')
  })

  it('失败任务展示后端错误码，避免只看到“失败”而无法定位', async () => {
    mocks.status.mockResolvedValue(makeStatus([{
      id: 'synthetic-run-failed', bindingId: 1, mode: 'integrity_full', reason: 'manual',
      status: 'failed', stage: 'finished', dryRun: false, progressCurrent: 0,
      progressTotal: null, resultCounts: {}, errorCode: 'reconcile_failed',
    }]))

    const root = mountPanel()
    await flushUi()

    expect(root.textContent).toContain('filesyncAdmin.jobError')
    expect(root.textContent).toContain('reconcile_failed')
  })
})
