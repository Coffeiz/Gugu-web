import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setLocale } from '@/i18n'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  run: vi.fn(),
  showError: vi.fn(),
  showNotice: vi.fn(),
  confirmDialog: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  scheduledTasksApi: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    delete: mocks.remove,
    run: mocks.run,
  },
}))
vi.mock('@/composables/core/useAppToast', () => ({
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  showAppError: mocks.showError,
  showAppNotice: mocks.showNotice,
}))
vi.mock('@/composables/core/useConfirmDialog', () => ({
  confirmDialog: mocks.confirmDialog,
}))

import { useScheduledTasks } from '@/composables/schedules/useScheduledTasks'

const task = { id: 7, name: '科技新闻', payload: '收集新闻', cron: '5 9 * * *', channels: ['web'], enabled: true }

describe('useScheduledTasks', () => {
  beforeEach(() => {
    setLocale('zh-CN')
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.list.mockResolvedValue({ tasks: [task] })
    mocks.create.mockResolvedValue({ id: 8 })
    mocks.update.mockResolvedValue({})
    mocks.remove.mockResolvedValue({})
    mocks.run.mockResolvedValue({ msg: '已发送' })
  })

  it('加载任务', async () => {
    const state = useScheduledTasks()
    await state.load()
    expect(state.tasks.value).toEqual([task])
    expect(state.loading.value).toBe(false)
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  it('保存时区分创建和更新，并在完成后刷新列表', async () => {
    const state = useScheduledTasks()
    await state.save(null, { name: '新任务' })
    expect(mocks.create).toHaveBeenCalledWith({ name: '新任务' })
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(state.busy.value).toBe(false)

    await state.save(7, { name: '已修改' })
    expect(mocks.update).toHaveBeenCalledWith(7, { name: '已修改' })
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('支持启停、试运行和删除，并把失败转为提示', async () => {
    const state = useScheduledTasks()
    await state.toggle(task)
    expect(mocks.update).toHaveBeenCalledWith(7, { enabled: false }, { mutationId: expect.any(String) })

    await state.runNow(task)
    expect(mocks.run).toHaveBeenCalledWith(7)
    expect(mocks.showNotice).toHaveBeenCalledWith('已发送')

    mocks.confirmDialog.mockResolvedValueOnce(true)
    await state.remove(task)
    expect(mocks.remove).toHaveBeenCalledWith(7)

    mocks.confirmDialog.mockResolvedValueOnce(false)
    mocks.remove.mockClear()
    await state.remove(task)
    expect(mocks.remove).not.toHaveBeenCalled()

    mocks.update.mockRejectedValueOnce(new Error('网络失败'))
    await state.toggle(task)
    expect(task.enabled).toBe(false)
    expect(mocks.showError).toHaveBeenCalledWith('更新任务失败：网络失败')

    mocks.run.mockRejectedValueOnce(new Error('执行失败'))
    await state.runNow(task)
    expect(mocks.showError).toHaveBeenCalledWith('执行失败：执行失败')

    mocks.remove.mockRejectedValueOnce(new Error('删除失败'))
    mocks.confirmDialog.mockResolvedValueOnce(true)
    await state.remove(task)
    expect(mocks.showError).toHaveBeenCalledWith('删除任务失败：删除失败')
  })
})
