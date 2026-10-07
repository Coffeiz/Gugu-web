// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import FileSyncReconcilePanel from '@/components/filesync/FileSyncReconcilePanel.vue'

const mocks = vi.hoisted(() => ({
  bindings: vi.fn(),
  runs: vi.fn(),
  previewDefault: vi.fn(),
  preview: vi.fn(),
  initialize: vi.fn(),
  reconcile: vi.fn(),
  cancelRun: vi.fn(),
  confirm: vi.fn(),
  setFileSyncEvent: (_event: unknown) => undefined,
  liveState: { connected: false, fileSyncEvent: null as unknown },
}))

vi.mock('@/api/filesync', () => ({
  filesyncUserApi: {
    bindings: mocks.bindings,
    runs: mocks.runs,
    previewDefault: mocks.previewDefault,
    preview: mocks.preview,
    initialize: mocks.initialize,
    reconcile: mocks.reconcile,
    cancelRun: mocks.cancelRun,
  },
}))

vi.mock('@/stores/live', async () => {
  const { reactive } = await import('vue')
  const state = reactive(mocks.liveState)
  mocks.setFileSyncEvent = event => { state.fileSyncEvent = event }
  return { useLiveStore: () => state }
})

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      key === 'filesyncUser.watcher' ? `${key}:${String(params?.status ?? '')}` : key,
  }) }
})

vi.mock('@/composables/core/useConfirmDialog', () => ({
  confirmDialog: mocks.confirm,
}))

vi.mock('@/components/common/controls/ActionButton.vue', () => ({
  default: { inheritAttrs: false, template: '<button v-bind="$attrs"><slot /></button>' },
}))

vi.mock('@/components/common/overlays/BaseModal.vue', () => ({
  default: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
}))

vi.mock('@/components/common/icons/Icon.vue', () => ({
  default: { template: '<span />' },
}))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

function mountPanel() {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(FileSyncReconcilePanel)
  app.mount(host)
  return host
}

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

const task = {
  id: 'run-synthetic-1', bindingId: 4, action: 'repair' as const,
  allowDelete: false, status: 'running' as const, stage: 'scanning',
  scannedCount: 8, resultCounts: { created: 0, updated: 0, moved: 0, deleted: 0, skipped: 0, conflicts: 0, failed: 0 },
  errorCode: null, revision: 1, cancelRequested: false,
  createdAt: null, startedAt: null, finishedAt: null,
}

const binding = {
  id: 4, source: 'local_directory', mode: 'bidirectional', rootPath: '.', status: 'active',
  revision: 1, watcherStatus: 'ready', needsReconcile: true, healthRevision: 3,
  gapRevision: 2, healthErrorCode: null, lastReconciledAt: '2026-10-06T00:00:00Z',
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
  for (const mock of [
    mocks.bindings, mocks.runs, mocks.previewDefault, mocks.preview, mocks.initialize,
    mocks.reconcile, mocks.cancelRun, mocks.confirm,
  ]) mock.mockReset()
  mocks.liveState.connected = false
  mocks.liveState.fileSyncEvent = null
})

describe('用户文件同步核对面板', () => {
  it('绑定监听已恢复但保留待核对标记，并在任务事件后补读权威结果', async () => {
    mocks.bindings.mockResolvedValue([binding])
    mocks.runs.mockResolvedValueOnce([task]).mockResolvedValue([{
      ...task,
      status: 'cancelled',
      resultCounts: { created: 1, updated: 0, moved: 0, deleted: 0, skipped: 0, conflicts: 0, failed: 0 },
    }])
    const root = mountPanel()
    root.querySelector('button')?.click()
    await flushUi()

    const bindingRow = root.querySelector('.fs-user-binding')
    expect(bindingRow?.textContent).toContain('filesyncUser.needsReconcile')
    expect(bindingRow?.textContent).toContain('ready')
    expect(root.querySelector('.fs-user-run')?.textContent).toContain('filesyncUser.status.running')

    mocks.setFileSyncEvent({
      protocol_version: 'live-event-v1', event_id: 'evt-synthetic-1',
      type: 'filesync.run.changed', run_id: task.id, binding_id: binding.id,
      revision: 2, created_at: '2026-10-07T00:00:00Z',
    })
    await new Promise(resolve => setTimeout(resolve, 160))
    await flushUi()

    expect(mocks.runs).toHaveBeenCalledTimes(2)
    expect(root.querySelector('.fs-user-run')?.textContent).toContain('filesyncUser.status.cancelled')
    expect(root.querySelector('.fs-user-run')?.textContent).toContain('filesyncUser.partialResult')
  })

  it('无绑定时先提供只读预检，预检返回任务后显示显式初始化入口', async () => {
    mocks.bindings.mockResolvedValueOnce([]).mockResolvedValue([{ ...binding, lastReconciledAt: null }])
    mocks.runs.mockResolvedValue([])
    mocks.previewDefault.mockResolvedValue(task)
    const root = mountPanel()
    root.querySelector('button')?.click()
    await flushUi()

    const buttons = [...root.querySelectorAll('button')]
    expect(buttons.some(button => button.textContent?.includes('filesyncUser.previewDefault'))).toBe(true)
    buttons.find(button => button.textContent?.includes('filesyncUser.previewDefault'))?.click()
    await flushUi()

    expect(mocks.previewDefault).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('filesyncUser.initialize')
    expect(root.textContent).toContain('filesyncUser.taskQueued')
  })
})
