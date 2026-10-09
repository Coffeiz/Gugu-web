// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import FileSyncAdminPanel from '@/components/filesync/FileSyncAdminPanel.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  runs: vi.fn(),
  resolveConflict: vi.fn(),
  reconcileIssues: vi.fn(),
  setWatchHardLimit: vi.fn(),
  expandWatchLimit: vi.fn(),
  invalidate: vi.fn(),
  startEvents: vi.fn(),
  stopEvents: vi.fn(),
}))

vi.mock('@/api/filesync', () => ({
  filesyncAdminApi: { status: mocks.status, runs: mocks.runs, resolveConflict: mocks.resolveConflict, reconcileIssues: mocks.reconcileIssues, setWatchHardLimit: mocks.setWatchHardLimit, expandWatchLimit: mocks.expandWatchLimit },
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
  mocks.resolveConflict.mockReset()
  mocks.reconcileIssues.mockReset()
  mocks.setWatchHardLimit.mockReset()
  mocks.expandWatchLimit.mockReset()
  mocks.invalidate.mockReset()
  mocks.startEvents.mockReset()
  mocks.stopEvents.mockReset()
})

describe('FileSyncAdminPanel 监听缺口提示', () => {
  it('管理员可读取容量并保存硬上限或手动扩一档', async () => {
    mocks.status.mockResolvedValue({
      featureEnabled: true, storageBackend: 'local', supported: true,
      workspaceShellSupported: true, ignoredBindingCount: 0, bindings: [], conflicts: [], failures: [],
      totals: { bindings: 0, journals: 0, pendingJournals: 0, failedJournals: 0,
        rejectedJournals: 0, pendingConflicts: 0, pendingOutbox: 0 },
      watcherCapacity: { available: true, uid: 1001, usage: 60000, limit: 65536, hardLimit: 1024000,
        percent: 91.55, autoThreshold: 52429, warningThreshold: 58983, atWarningThreshold: true,
        nextLimit: 131072, atHardLimit: false, lastExpansionAt: null },
      generatedAt: '2026-10-07T00:00:00Z',
    })
    mocks.runs.mockResolvedValue([])
    mocks.setWatchHardLimit.mockResolvedValue({})
    mocks.expandWatchLimit.mockResolvedValue({ expanded: true })
    const root = mountPanel()
    await flushUi()

    expect(root.querySelector('.fs-capacity-stats')?.textContent).toContain('60000')
    expect(root.querySelector('.fs-capacity-stats')?.textContent).toContain('filesyncAdmin.watcherAtWarning')
    const input = root.querySelector<HTMLInputElement>('.fs-capacity-limit input')!
    input.value = '524288'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    const saveButton = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('saveWatcherLimit'))
    saveButton?.click()
    await flushUi()
    expect(mocks.setWatchHardLimit).toHaveBeenCalledWith(expect.any(Function), 524288)

    const expandButton = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('expandWatcherLimit'))
    expandButton?.click()
    await flushUi()
    expect(mocks.expandWatchLimit).toHaveBeenCalledWith(expect.any(Function))
  })

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

  it('预览显示只读计划数量，安全阻止恢复时给出可操作原因', async () => {
    mocks.status.mockResolvedValue({
      featureEnabled: true, storageBackend: 'local', supported: true,
      workspaceShellSupported: true, ignoredBindingCount: 0, bindings: [], conflicts: [],
      failures: [], totals: { bindings: 0, journals: 0, pendingJournals: 0,
        failedJournals: 0, rejectedJournals: 0, pendingConflicts: 0, pendingOutbox: 0 },
      generatedAt: '2026-10-07T00:00:00Z',
    })
    mocks.runs.mockResolvedValue([
      {
        id: 'preview-1', bindingId: 4, action: 'dry_run', allowDelete: false,
        status: 'succeeded', stage: 'finished', scannedCount: 12,
        resultCounts: { plannedCreated: 2, plannedUpdated: 1, plannedDeleted: 3, conflicts: 1, permissionSkipped: 2 },
        errorCode: null, revision: 1, cancelRequested: false,
        createdAt: null, startedAt: null, finishedAt: null,
      },
      {
        id: 'repair-1', bindingId: 5, action: 'repair', allowDelete: false,
        status: 'failed', stage: 'failed', scannedCount: 0,
        resultCounts: {}, errorCode: 'root_recovery_blocked', revision: 1,
        cancelRequested: false, createdAt: null, startedAt: null, finishedAt: null,
      },
      {
        id: 'repair-2', bindingId: 6, action: 'repair', allowDelete: false,
        status: 'failed', stage: 'failed', scannedCount: 0,
        resultCounts: {}, errorCode: 'binding_root_unavailable', revision: 1,
        cancelRequested: false, createdAt: null, startedAt: null, finishedAt: null,
      },
    ])

    const root = mountPanel()
    await flushUi()

    const runs = root.querySelectorAll('.fs-run')
    expect(runs).toHaveLength(3)
    expect(runs[0].textContent).toContain('filesyncUser.previewResults')
    expect(runs[0].textContent).not.toContain('filesyncUser.results')
    expect(runs[0].textContent).toContain('filesyncUser.permissionSkipped')
    expect(runs[1].textContent).toContain('filesyncUser.rootRecoveryBlocked')
    expect(runs[2].textContent).toContain('filesyncUser.bindingRootUnavailable')
  })

  it('路径投影失败展示脱敏原因分类而不是只显示总失败码', async () => {
    mocks.status.mockResolvedValue({
      featureEnabled: true, storageBackend: 'local', supported: true,
      workspaceShellSupported: true, ignoredBindingCount: 0, bindings: [], conflicts: [],
      failures: [], totals: { bindings: 0, journals: 0, pendingJournals: 0,
        failedJournals: 0, rejectedJournals: 0, pendingConflicts: 0, pendingOutbox: 0 },
      generatedAt: '2026-10-07T00:00:00Z',
    })
    mocks.runs.mockResolvedValue([{
      id: 'repair-projection', bindingId: 42, action: 'repair', allowDelete: false,
      status: 'failed', stage: 'failed', scannedCount: 10,
      resultCounts: { failed: 3, skipped: 3, rejected_quota_exceeded: 2, rejected_file_unavailable: 1 },
      errorCode: 'path_projection_failed', revision: 1, cancelRequested: false,
      createdAt: null, startedAt: null, finishedAt: null,
    }])

    const root = mountPanel()
    await flushUi()

    const text = root.querySelector('.fs-run')?.textContent || ''
    expect(text).toContain('filesyncUser.projectionFailed')
    expect(text).toContain('filesyncUser.projectionReason.quota_exceeded 2')
    expect(text).toContain('filesyncUser.projectionReason.file_unavailable 1')
  })
})

describe('FileSyncAdminPanel 批量排入异常对账', () => {
  it('只对异常有效绑定显示批量排队入口，且请求服务端重新判定', async () => {
    const bindings = [
      {
        id: 1, userId: 'synthetic-user', source: 'local_directory', mode: 'bidirectional',
        status: 'active', protocolVersion: 1, rootPath: '.', revision: 0,
        watcherStatus: 'degraded', needsReconcile: true, healthRevision: 1, gapRevision: 1,
        healthErrorCode: 'watcher_error', lastReconciledAt: null, updatedAt: null,
        pendingJournal: 0, failedJournal: 0, rejectedJournal: 0, pendingConflicts: 0,
      },
      {
        id: 2, userId: 'synthetic-user', source: 'local_directory', mode: 'bidirectional',
        status: 'active', protocolVersion: 1, rootPath: 'other', revision: 0,
        watcherStatus: 'ready', needsReconcile: false, healthRevision: 1, gapRevision: 0,
        healthErrorCode: null, lastReconciledAt: null, updatedAt: null,
        pendingJournal: 0, failedJournal: 0, rejectedJournal: 0, pendingConflicts: 0,
      },
    ]
    const status = {
      featureEnabled: true, storageBackend: 'local', supported: true,
      workspaceShellSupported: true, ignoredBindingCount: 0, bindings,
      conflicts: [], failures: [], totals: {
        bindings: 2, journals: 0, pendingJournals: 0, failedJournals: 0,
        rejectedJournals: 0, pendingConflicts: 0, pendingOutbox: 0,
      }, generatedAt: '2026-10-07T00:00:00Z',
    }
    mocks.status.mockResolvedValue(status)
    mocks.runs.mockResolvedValue([])
    mocks.reconcileIssues.mockResolvedValue({
      eligible: 1, queued: 1, busy: 0, skipped: 0,
    })

    const root = mountPanel()
    await flushUi()
    const button = root.querySelector<HTMLButtonElement>('.fs-block-head button')
    expect(button?.textContent).toContain('filesyncAdmin.queueIssues')
    button?.click()
    await flushUi()

    expect(confirmDialog).toHaveBeenCalled()
    expect(mocks.reconcileIssues).toHaveBeenCalledTimes(1)
    expect(root.querySelector('.fs-message.is-success')?.textContent).toContain('filesyncAdmin.queueIssuesResult')
  })
})

describe('FileSyncAdminPanel 批量处理冲突', () => {
  function conflict(id: number) {
    return {
      id, bindingId: 7, userId: 'synthetic-user', relativePath: `folder/file-${id}.txt`,
      source: 'local_directory', status: 'pending', hasBaseline: true,
      hasLocal: true, hasRemote: true, createdAt: null,
    }
  }

  function status(conflicts: ReturnType<typeof conflict>[], pendingConflicts = conflicts.length) {
    return {
      featureEnabled: true, storageBackend: 'local', supported: true, workspaceShellSupported: true,
      ignoredBindingCount: 0, bindings: [], conflicts, failures: [],
      totals: {
        bindings: 0, journals: 0, pendingJournals: 0, failedJournals: 0,
        rejectedJournals: 0, pendingConflicts, pendingOutbox: 0,
      },
      generatedAt: '2026-10-07T00:00:00Z',
    }
  }

  it('确认后逐条应用同一策略并在界面报告完成数', async () => {
    const conflicts = [conflict(11), conflict(12), conflict(13)]
    mocks.status.mockResolvedValue(status(conflicts))
    mocks.runs.mockResolvedValue([])
    mocks.resolveConflict.mockResolvedValue({ status: 'resolved', resolution: 'keep_local' })

    const root = mountPanel()
    await flushUi()
    const bulkButtons = root.querySelectorAll('.fs-bulk-actions button')
    expect(bulkButtons).toHaveLength(4)
    bulkButtons.item(0)?.click()
    await flushUi()

    expect(mocks.resolveConflict).toHaveBeenCalledTimes(3)
    expect(mocks.resolveConflict.mock.calls.map(([ , id, resolution ]) => [id, resolution])).toEqual([
      [11, 'keep_local'], [12, 'keep_local'], [13, 'keep_local'],
    ])
    await vi.waitFor(() => {
      expect(root.querySelector('.fs-message.is-success')?.textContent).toContain('filesyncAdmin.bulkResolveResult')
    })
  })

  it('冲突列表被截断时禁用批量操作，不会只处理部分记录', async () => {
    mocks.status.mockResolvedValue(status([conflict(11)], 244))
    mocks.runs.mockResolvedValue([])

    const root = mountPanel()
    await flushUi()

    const bulkButtons = [...root.querySelectorAll<HTMLButtonElement>('.fs-bulk-actions button')]
    expect(bulkButtons).toHaveLength(4)
    expect(bulkButtons.every((button) => button.disabled)).toBe(true)
    expect(root.querySelector('.fs-block-head + .fs-note')?.textContent).toContain('filesyncAdmin.bulkListIncomplete')
    expect(mocks.resolveConflict).not.toHaveBeenCalled()
  })

  it('本地文件缺失时仅提供适用的单项操作并禁用批量处理', async () => {
    const missing = { ...conflict(31), hasLocal: false, hasRemote: true }
    mocks.status.mockResolvedValue(status([missing]))
    mocks.runs.mockResolvedValue([])

    const root = mountPanel()
    await flushUi()

    const bulkButtons = [...root.querySelectorAll<HTMLButtonElement>('.fs-bulk-actions button')]
    expect(bulkButtons).toHaveLength(4)
    expect(bulkButtons.every((button) => button.disabled)).toBe(true)
    expect(root.querySelector('.fs-block-head + .fs-note')?.textContent).toContain('filesyncAdmin.bulkMissingLocalDisabled')
    expect(root.querySelector('.fs-row-main small')?.textContent).toContain('filesyncAdmin.missingLocalConflictHint')
    const conflictButtons = [...root.querySelectorAll<HTMLButtonElement>('.fs-row .fs-actions button')]
    expect(conflictButtons).toHaveLength(3)
    expect(conflictButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('filesyncAdmin.keepRemote'),
      expect.stringContaining('filesyncAdmin.cancelConflict'),
      expect.stringContaining('filesyncAdmin.confirmMissingDelete'),
    ])
  })

  it('单条失败时继续处理后续冲突并报告部分成功', async () => {
    const conflicts = [conflict(21), conflict(22), conflict(23)]
    mocks.status.mockResolvedValue(status(conflicts))
    mocks.runs.mockResolvedValue([])
    mocks.resolveConflict
      .mockResolvedValueOnce({ status: 'resolved', resolution: 'keep_local' })
      .mockRejectedValueOnce(new Error('synthetic conflict failure'))
      .mockResolvedValueOnce({ status: 'resolved', resolution: 'keep_local' })

    const root = mountPanel()
    await flushUi()
    root.querySelectorAll<HTMLButtonElement>('.fs-bulk-actions button').item(0)?.click()
    await flushUi()

    expect(mocks.resolveConflict).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => {
      expect(root.querySelector('.fs-message.is-error')?.textContent).toContain('filesyncAdmin.bulkResolveResult')
    })
  })
})
