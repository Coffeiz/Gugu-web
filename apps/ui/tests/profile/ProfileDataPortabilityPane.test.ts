// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { desktopProfileKey } from '@/components/common/profile/desktopProfile'
import ProfileDataPortabilityPane from '@/components/common/profile/ProfileDataPortabilityPane.vue'

const mocks = vi.hoisted(() => ({
  importJobs: [] as Array<Record<string, unknown>>,
  listImports: vi.fn(),
  resumeImport: vi.fn(),
  deleteImport: vi.fn(),
  confirm: vi.fn(),
  desktopAccess: vi.fn(),
  createExport: vi.fn(),
}))

vi.mock('@/services/localPreferencesAccess', () => ({ useLocalPreferencesAccess: mocks.desktopAccess }))
vi.mock('@/services/api', () => ({
  dataPortabilityApi: {
    preview: vi.fn().mockResolvedValue({
      categories: { projects: { records: 1, bytes: 0 }, files: { records: 2, bytes: 1024 } },
      format_version: '1.0',
    }),
    createExport: mocks.createExport,
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

function mountPane(desktop = false) {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(ProfileDataPortabilityPane)
  app.provide(desktopProfileKey, desktop)
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
  mocks.desktopAccess.mockReset().mockReturnValue(null)
  mocks.createExport.mockReset().mockResolvedValue(undefined)
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

it('桌面表单只显示当前预检包并等待确认后导入', async () => {
  const preflightBusinessArchive = vi.fn()
    .mockResolvedValueOnce({ id: 'first', added: 1, skipped: 0 })
    .mockResolvedValueOnce({ id: 'second', added: 2, skipped: 1 })
  const applyBusinessArchive = vi.fn().mockResolvedValue({ added: 2, skipped: 1 })
  mocks.desktopAccess.mockReturnValue({
    preflightBusinessArchive, applyBusinessArchive,
    dataInventory: vi.fn().mockResolvedValue({ projects: 0, clients: 0 }),
  })
  const root = mountPane(true)
  await flushUi()
  const button = (key: string) => Array.from(root.querySelectorAll('button'))
    .find(element => element.textContent?.trim() === `profileDataUi.${key}`)!
  button('preflight').click()
  await flushUi()
  button('preflight').click()
  await flushUi()
  expect(root.textContent).not.toContain('profileDataUi.importJobs')
  expect(root.textContent).not.toContain('profileDataUi.jobs')
  expect(root.querySelectorAll('.data-import .data-job')).toHaveLength(1)
  mocks.confirm.mockResolvedValueOnce(false)
  button('incrementalImport').click()
  await flushUi()
  expect(applyBusinessArchive).not.toHaveBeenCalled()
  button('incrementalImport').click()
  await flushUi()
  expect(applyBusinessArchive).toHaveBeenCalledExactlyOnceWith('second')
  expect(root.querySelector('.data-job')?.textContent).toContain('profileDataUi.importCompleted')
})

it('Web 导出忽略旧预览返回的文件库类别', async () => {
  const root = mountPane()
  await flushUi()
  expect(root.textContent).not.toContain('profileDataUi.category_files')
  const button = Array.from(root.querySelectorAll('button'))
    .find(element => element.textContent?.trim() === 'profileDataUi.createExport')!
  button.click()
  await flushUi()
  expect(mocks.createExport).toHaveBeenCalledExactlyOnceWith(['projects'], expect.any(String))
})
