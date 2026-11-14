// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import GhostRecordCleanup from '@/views/Admin/StorageAudit/components/GhostRecordCleanup.vue'

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

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

function mountCleanup(ghostIds: number[], onRefresh?: (preserveMessage: boolean) => void, onMessage?: (message: { text: string; kind: 'ok' | 'err' }) => void, ghosts = [{
  id: 41, name: 'missing.png', space: 'personal', project: null, deleted: false,
  storage_key: 'synthetic/个人文件/missing.png',
}]) {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(GhostRecordCleanup, {
    ghostCount: ghostIds.length,
    ghostIds,
    ghosts,
    onRefresh,
    onMessage,
  })
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

describe('Admin 幽灵文件记录清理', () => {
  it('确认后分批提交完整 ID，并展示已处理进度，完成后刷新报告', async () => {
    const ids = Array.from({ length: 601 }, (_, index) => index + 1)
    const submittedBatches: number[][] = []
    let postCount = 0
    let releaseSecondBatch: ((response: ReturnType<typeof jsonResponse>) => void) | undefined
    mocks.authFetch.mockImplementation((_url: string, init?: RequestInit) => {
      postCount += 1
      const body = JSON.parse(String(init?.body)) as { file_ids: number[] }
      submittedBatches.push(body.file_ids)
      if (postCount === 2) {
        return new Promise((resolve) => { releaseSecondBatch = resolve })
      }
      return Promise.resolve(jsonResponse({ done: body.file_ids, failed: [] }))
    })
    mocks.confirmDialog.mockResolvedValue(true)

    const refresh = vi.fn()
    const message = vi.fn()
    const root = mountCleanup(ids, refresh, message)
    root.querySelector('.ghost-cleanup__head button')?.click()
    await flushUi()

    expect(mocks.confirmDialog).toHaveBeenCalledOnce()
    expect(submittedBatches).toEqual([ids.slice(0, 300), ids.slice(300, 600)])
    const progress = root.querySelector('[role="progressbar"]')
    expect(progress?.getAttribute('aria-valuemax')).toBe('601')
    expect(progress?.getAttribute('aria-valuenow')).toBe('300')

    releaseSecondBatch?.(jsonResponse({ done: submittedBatches[1], failed: [] }))
    await flushUi()

    expect(submittedBatches).toHaveLength(3)
    expect(submittedBatches[2]).toEqual([601])
    expect(root.querySelector('[role="progressbar"]')).toBeNull()
    expect(message).toHaveBeenCalledWith({
      kind: 'ok',
      text: 'storageAuditExtra.ghostRepairResult',
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(true)
  })

  it('取消确认时不发请求也不触发刷新', async () => {
    mocks.confirmDialog.mockResolvedValue(false)
    const refresh = vi.fn()
    const message = vi.fn()
    const root = mountCleanup([41], refresh, message)

    root.querySelector('.recon-row button')?.click()
    await flushUi()

    expect(mocks.authFetch).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(message).not.toHaveBeenCalled()
  })
})
