// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import ProfileDataPortabilityPane from '@/components/common/profile/ProfileDataPortabilityPane.vue'

const mocks = vi.hoisted(() => ({
  importJobs: [] as Array<Record<string, unknown>>,
  listImports: vi.fn(),
  resumeImport: vi.fn(),
  deleteImport: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  dataPortabilityApi: {
    preview: vi.fn().mockResolvedValue({ categories: {}, format_version: '1.0' }),
    listExports: vi.fn().mockResolvedValue([]),
    listImports: mocks.listImports,
    resumeImport: mocks.resumeImport,
    deleteImport: mocks.deleteImport,
  },
}))

vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: mocks.confirm }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

function mountPane() {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(ProfileDataPortabilityPane)
  app.mount(host)
  return host
}

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  mocks.importJobs = [
    { id: 'failed-job', status: 'failed', mode: 'incremental', stage: 'failed', preview: null },
    { id: 'preflight-job', status: 'preview_ready', mode: 'preflight', stage: 'preview_ready', preview: {} },
    { id: 'completed-job', status: 'completed', mode: 'incremental', stage: 'completed', preview: {} },
  ]
  mocks.listImports.mockImplementation(async () => [...mocks.importJobs])
  mocks.resumeImport.mockImplementation(async (id: string) => ({
    ...mocks.importJobs.find(job => job.id === id), import_token: 'temporary-token',
  }))
  mocks.deleteImport.mockReset().mockResolvedValue(undefined)
  mocks.confirm.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
})

describe('数据迁移导入任务历史', () => {
  it('允许删除失败和预检任务；增量导入完成时说明当前不支持撤回', async () => {
    const root = mountPane()
    await flushUi()

    const cards = root.querySelectorAll('.data-jobs')[0].querySelectorAll('.data-job')
    const failedActions = cards[0].querySelector('.data-job-actions')!
    const preflightActions = cards[1].querySelector('.data-job-actions')!
    const completed = cards[2]
    expect(failedActions.textContent).toContain('profileDataUi.deleteImport')
    expect(preflightActions.textContent).toContain('profileDataUi.deleteImport')
    expect(completed.querySelector('.data-job-actions')?.textContent).not.toContain('profileDataUi.undoReplace')
    expect(completed.textContent).toContain('profileDataUi.incrementalNoRollback')

    ;(failedActions.querySelector('button') as HTMLButtonElement).click()
    await flushUi()
    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.deleteImport).toHaveBeenCalledWith('failed-job')
    expect(root.textContent).not.toContain('failed-job')
  })
})
