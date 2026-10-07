// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import FileSyncAdminPanel from '@/components/filesync/FileSyncAdminPanel.vue'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  cancel: vi.fn(),
  run: vi.fn(),
  setBackgroundReconcileEnabled: vi.fn(),
  authFetch: vi.fn(),
}))

vi.mock('@/stores/admin', () => ({
  useAdminStore: () => ({ authFetch: mocks.authFetch }),
}))
vi.mock('@/api/filesync', () => ({
  filesyncAdminApi: {
    status: mocks.status,
    cancel: mocks.cancel,
    run: mocks.run,
    setBackgroundReconcileEnabled: mocks.setBackgroundReconcileEnabled,
    setEnabled: vi.fn(),
    dryRun: vi.fn(),
    reconcile: vi.fn(),
    resolveConflict: vi.fn(),
  },
}))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({
    t: (key: string, values: Record<string, string | number> = {}) => {
      const labels: Record<string, string> = {
        'filesyncAdmin.jobs': '最近对账任务',
        'filesyncAdmin.jobQueueSummary': '运行中 {running} · 排队 {queued} · 暂停 {paused}',
        'filesyncAdmin.jobState': '任务 {id} · {mode} · {reason} · {status} · 阶段 {stage}',
        'filesyncAdmin.scanProgress': '已检查 {scanned} 项 · 哈希 {hashed} · 复用 {reused} · 拒绝 {rejected}',
        'filesyncAdmin.statusRunning': '运行中',
        'filesyncAdmin.statusCancelled': '已取消',
        'filesyncAdmin.stageScanning': '扫描目录',
        'filesyncAdmin.reasonDaily': '每日补偿',
        'filesyncAdmin.cancelJob': '取消任务',
      }
      return (labels[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ''))
    },
  }),
}))
vi.mock('@/components/common/controls/ActionButton.vue', () => ({
  default: {
    inheritAttrs: false,
    props: ['disabled'],
    setup(props: { disabled?: boolean }, { attrs, slots }: { attrs: Record<string, unknown>; slots: { default?: () => unknown } }) {
      return () => h('button', { ...attrs, disabled: props.disabled }, slots.default?.())
    },
  },
}))
vi.mock('@/components/common/controls/ToggleSwitch.vue', () => ({
  default: {
    inheritAttrs: false,
    props: ['modelValue', 'disabled'],
    emits: ['update:modelValue'],
    setup(props: { modelValue?: boolean; disabled?: boolean }, { attrs, emit }: {
      attrs: Record<string, unknown>
      emit: (event: 'update:modelValue', value: boolean) => void
    }) {
      return () => h('button', {
        ...attrs,
        type: 'button',
        disabled: props.disabled,
        'aria-pressed': String(Boolean(props.modelValue)),
        onClick: () => emit('update:modelValue', !props.modelValue),
      }, 'toggle')
    },
  },
}))
vi.mock('@/components/common/icons/Icon.vue', () => ({ default: { render: () => h('span') } }))

const run = {
  id: 'run-12345678-abcd', userId: 'synthetic-user', bindingId: 8,
  mode: 'snapshot_diff', reason: 'daily', status: 'running', stage: 'scanning',
  dryRun: false, progressCurrent: 12, progressTotal: null,
  resultCounts: { scanned: 12, hashed: 5, reused: 7, rejected: 0 },
  errorCode: null, pauseReason: null, nextRunAt: null, cumulativeRuntimeSeconds: 4,
  createdAt: '2026-10-06T00:00:00Z', startedAt: '2026-10-06T00:00:01Z', finishedAt: null,
}

function statusWith(runStatus: string, backgroundReconcileEnabled = true) {
  return {
    featureEnabled: true, backgroundReconcileEnabled, storageBackend: 'local', supported: true,
    workspaceShellSupported: true, ignoredBindingCount: 0,
    bindings: [], conflicts: [],
    reconcileRuns: [{ ...run, status: runStatus }],
    userScanStates: [], failures: [],
    totals: { bindings: 0, journals: 0, pendingJournals: 0, failedJournals: 0, rejectedJournals: 0, pendingConflicts: 0, pendingOutbox: 0 },
    generatedAt: '2026-10-06T00:00:00Z',
  }
}

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('文件同步管理员任务队列', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.status.mockReset().mockResolvedValue(statusWith('running'))
    mocks.cancel.mockReset().mockResolvedValue({
      ...run, status: 'cancelled', stage: 'finished', errorCode: 'cancelled', finishedAt: '2026-10-06T00:00:02Z',
    })
    mocks.run.mockReset()
    mocks.authFetch.mockReset()
    mocks.setBackgroundReconcileEnabled.mockReset().mockResolvedValue({})
  })

  afterEach(() => {
    app?.unmount()
    host?.remove()
    app = undefined
    host = undefined
    vi.useRealTimers()
  })

  it('展示扫描计数；取消后立即显示服务端终态并隐藏可取消操作', async () => {
    host = document.createElement('div')
    document.body.append(host)
    app = createApp(FileSyncAdminPanel)
    app.mount(host)
    await flushUi()

    expect(host.textContent).toContain('已检查 12 项 · 哈希 5 · 复用 7 · 拒绝 0')
    const cancelButton = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('取消任务'))
    expect(cancelButton).toBeTruthy()
    cancelButton!.click()
    await flushUi()

    expect(mocks.cancel).toHaveBeenCalledWith(mocks.authFetch, run.id)
    expect(host.textContent).toContain('已取消')
    expect([...host.querySelectorAll('button')].some(button => button.textContent?.includes('取消任务'))).toBe(false)
  })

  it('并发任务分别展示扫描进度并逐条轮询状态', async () => {
    const secondRun = {
      ...run, id: 'run-87654321-abcd', progressCurrent: 4,
      resultCounts: { scanned: 4, hashed: 2, reused: 2, rejected: 0 },
    }
    mocks.status.mockResolvedValue({
      ...statusWith('running'), reconcileRuns: [{ ...run }, secondRun],
    })
    mocks.run.mockImplementation(async (_auth: unknown, runId: string) => ({
      ...(runId === run.id ? run : secondRun),
      resultCounts: {
        ...(runId === run.id ? run.resultCounts : secondRun.resultCounts),
        scanned: runId === run.id ? 14 : 6,
      },
    }))

    host = document.createElement('div')
    document.body.append(host)
    app = createApp(FileSyncAdminPanel)
    app.mount(host)
    await flushUi()

    expect(host.textContent).toContain('运行中 2 · 排队 0 · 暂停 0')
    expect(host.textContent).toContain('已检查 12 项 · 哈希 5 · 复用 7 · 拒绝 0')
    expect(host.textContent).toContain('已检查 4 项 · 哈希 2 · 复用 2 · 拒绝 0')

    await vi.advanceTimersByTimeAsync(1500)
    await flushUi()

    expect(mocks.run).toHaveBeenCalledTimes(2)
    expect(mocks.run.mock.calls.map(([, runId]) => runId)).toEqual([run.id, secondRun.id])
    expect(host.textContent).toContain('已检查 14 项')
    expect(host.textContent).toContain('已检查 6 项')
  })

  it('单独暂停后台对账开关，不操作实时同步总开关', async () => {
    mocks.status
      .mockResolvedValueOnce(statusWith('running', true))
      .mockResolvedValueOnce(statusWith('running', false))
    host = document.createElement('div')
    document.body.append(host)
    app = createApp(FileSyncAdminPanel)
    app.mount(host)
    await flushUi()

    const toggle = host.querySelector<HTMLButtonElement>(
      'button[aria-label="filesyncAdmin.toggleBackgroundReconcile"]',
    )
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
    toggle?.click()
    await flushUi()

    expect(mocks.setBackgroundReconcileEnabled).toHaveBeenCalledWith(mocks.authFetch, false)
    expect(host.querySelector<HTMLButtonElement>(
      'button[aria-label="filesyncAdmin.toggleBackgroundReconcile"]',
    )?.getAttribute('aria-pressed')).toBe('false')
  })
})
