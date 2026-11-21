// @vitest-environment jsdom
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import { scheduleAccessKey } from '@/services/scheduleAccess'
import { mindAccessKey } from '@/services/mindAccess'
import { desktopScheduleAccess } from '@desktop/schedules/access'
import { desktopMindAccess } from '@desktop/mind/access'
import { localDayKey } from '@/utils/dateAttribution'
import { initializeDesktopTheme } from '@/composables/core/useTheme'
import { installEnterDirective } from '@/directives/enter'
import { projectAccessKey, type ProjectAccess } from '@/api/projects'
import { localPreferencesAccessKey } from '@/services/localPreferencesAccess'
import { desktopPreferencesAccess } from '@desktop/account/preferencesAccess'
import { projectBoardMethods } from '@desktop/bridge/preview-core'
import { desktopProjectAccess } from '@desktop/projects/access'
import ProjectWindow from '@desktop/projects/ProjectWindow.vue'
import { useProjectStore } from '@/stores/projects'
import DesktopShell from '@desktop/shell/index.vue'

vi.mock('@desktop/shell/components/DesktopGuguChat.vue', () => ({ default: { render: () => null } }))

const pendingKey = 'gugu.desktop.pending-operation'
const operationId = '00000000-0000-4000-8000-000000000001'
const ok = <T>(result: T) => ({ ok: true, result })

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

async function mountShell(section: 'home' | 'contacts' | 'projects' | 'calendar', bridge: Record<string, unknown> | null, list?: ProjectAccess['list']) {
  vi.stubGlobal('guguDesktop', bridge && {
    appearance: async () => ok({ theme: 'light', themeFamily: 'glass', palette: 'neutral', defaultView: section }),
    onboarding: async () => ok(null),
    calendar: async () => ok([]),
    undoPreview: async () => ok({}),
    sandboxStatus: async () => ok({ supported: false, methods: [], checkAvailable: false }),
    ...bridge,
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'home', components: {} }, { path: '/contacts', name: 'contacts', components: {} }, { path: '/projects', name: 'projects', components: {} }, { path: '/calendar', name: 'calendar', components: {} }] })
  await router.push({ name: section })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(DesktopShell).use(createPinia()).use(router).use(i18n)
    .provide(projectAccessKey, list ? { ...desktopProjectAccess, list } : desktopProjectAccess)
    .provide(localPreferencesAccessKey, desktopPreferencesAccess)
    .provide(scheduleAccessKey, desktopScheduleAccess)
    .provide(mindAccessKey, desktopMindAccess)
  installEnterDirective(app)
  app.mount(host)

  return {
    host, router,
    cleanup() {
      app.unmount()
      host.remove()
      localStorage.removeItem(pendingKey)
      vi.unstubAllGlobals()
    },
  }
}

async function clickButton(container: ParentNode, label: string) {
  const button = await vi.waitFor(() => {
    const matched = Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent?.trim() === label)
    expect(matched?.disabled).toBe(false)
    return matched!
  })
  button.click()
}

it.each([{ available: true }, { available: false }])('桌面启动恢复待确认操作，收据已存在 $available', async ({ available }) => {
  const persistedReceipt = { method: 'projects.create', result: { id: 1 } }
  const receipt = vi.fn(async (_id: string) => ok(available ? persistedReceipt : null))
  const clients = vi.fn(async () => ok([]))
  const list = vi.fn(async () => [])
  localStorage.setItem(pendingKey, operationId)
  const { host, cleanup } = await mountShell('home', { receipt, clients }, list)

  try {
    if (!available) {
      await vi.waitFor(() => expect(host.textContent).toContain('暂未找到操作收据'))
      await vi.waitFor(() => expect(clients).toHaveBeenCalledTimes(1))
      expect(receipt).toHaveBeenCalledExactlyOnceWith(operationId)
      expect(localStorage.getItem(pendingKey)).toBe(operationId)

      receipt.mockResolvedValueOnce(ok(persistedReceipt))
      const retry = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('查询待确认操作'))
      expect(retry?.disabled).toBe(false)
      retry?.click()
    }

    await vi.waitFor(() => expect(host.textContent).toContain('已查询到操作收据，本地数据已刷新'))
    expect(receipt.mock.calls).toEqual(available ? [[operationId]] : [[operationId], [operationId]])
    await vi.waitFor(() => expect(clients).toHaveBeenCalledTimes(2))
    expect(list).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(pendingKey)).toBeNull()
    expect(host.textContent).not.toContain('查询待确认操作')
  } finally {
    cleanup()
  }
})


it('联系人取消重命名不写入，保存后重读本地列表', async () => {
  let rows = [{ id: 4, name: '旧联系人' }]
  const clients = vi.fn(async () => ok(rows))
  const renameClient = vi.fn(async (id: number, name: string) => {
    rows = [{ id, name }]
    return ok(rows[0])
  })
  const { host, cleanup } = await mountShell('contacts', { clients, renameClient })
  try {
    const contacts = host.querySelector('#desktop-clients')!
    await clickButton(contacts, '重命名')
    await clickButton(contacts, '取消')
    expect(renameClient).not.toHaveBeenCalled()
    expect(contacts.textContent).toContain('旧联系人')

    await clickButton(contacts, '重命名')
    const input = await vi.waitFor(() => {
      const field = contacts.querySelector<HTMLInputElement>('input[aria-label="联系人名称"]')
      expect(field).not.toBeNull()
      return field!
    })
    input.value = '新联系人'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(contacts.textContent).toContain('新联系人'))
    expect(renameClient).toHaveBeenCalledExactlyOnceWith(4, '新联系人')
    expect(clients).toHaveBeenCalledTimes(2)
  } finally {
    cleanup()
  }
})

it('联系人删除取消时不写入，确认后删除并重读本地列表', async () => {
  let rows = [{ id: 7, name: '待删除联系人' }]
  const clients = vi.fn(async () => ok(rows))
  const deleteClient = vi.fn(async () => {
    rows = []
    return ok(null)
  })
  const { host, cleanup } = await mountShell('contacts', { clients, deleteClient })
  try {
    const contacts = host.querySelector('#desktop-clients')!
    await clickButton(contacts, '删除')
    const cancel = await vi.waitFor(() => {
      const dialog = document.querySelector('.confirm-dialog.is-danger')
      expect(dialog?.textContent).toContain('待删除联系人')
      return dialog!.querySelector<HTMLButtonElement>('.confirm-dialog-cancel')!
    })
    cancel.click()
    expect(deleteClient).not.toHaveBeenCalled()
    expect(contacts.textContent).toContain('待删除联系人')

    await vi.waitFor(() => expect(cancel.isConnected).toBe(false))
    await clickButton(contacts, '删除')
    await clickButton(document, '删除联系人')

    await vi.waitFor(() => expect(contacts.textContent).toContain('这里会保存你的联系人'))
    expect(deleteClient).toHaveBeenCalledExactlyOnceWith(7)
    expect(clients).toHaveBeenCalledTimes(2)
  } finally {
    cleanup()
  }
})


it.each([{ uncertain: false }, { uncertain: true }])('桌面项目创建经过本机桥，结果未确认 $uncertain', async ({ uncertain }) => {
  const project = { id: 41, name: '合成桌面项目', status: 'pending', version: 1, stages: [] }
  let rows: typeof project[] = []
  const projectBoard = vi.fn(async () => ok({ items: rows, nextOffset: null }))
  const createBoardProject = vi.fn(async () => {
    if (uncertain) return { ok: false, error: { code: 'unknown_result', message: '结果未确认，请查询操作收据', operationId } }
    rows = [project]
    return ok(project)
  })
  const { host, router, cleanup } = await mountShell('projects', {
    ...Object.fromEntries(projectBoardMethods.map(method => [method, async () => ok(null)])),
    clients: async () => ok([]), projectBoard, createBoardProject,
  })
  try {
    await vi.waitFor(() => expect(projectBoard).toHaveBeenCalledWith('active', 0))
    await clickButton(host.querySelector('[aria-label="项目工具栏"]')!, i18n.global.t('common.actions.createProject'))
    const input = await vi.waitFor(() => {
      const field = document.querySelector<HTMLInputElement>('.header-name-input')
      expect(field).not.toBeNull()
      return field!
    })
    input.value = project.name
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await clickButton(document, i18n.global.t('projects.create'))

    await vi.waitFor(() => expect(createBoardProject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: project.name }), expect.any(String),
    ))
    if (uncertain) {
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain(operationId))
      expect(input.value).toBe(project.name)
      expect(input.isConnected).toBe(true)
      expect(localStorage.getItem(pendingKey)).toBe(operationId)
      expect(host.textContent).toContain('查询待确认操作')
      expect(host.textContent).not.toContain(project.name)
    } else {
      await vi.waitFor(() => expect(host.textContent).toContain(project.name))
      expect(localStorage.getItem(pendingKey)).toBeNull()
      await router.push({ name: 'home' })
      await clickButton(host, '刷新本地数据')
      await vi.waitFor(() => expect(projectBoard).toHaveBeenCalledTimes(2))
      await router.push({ name: 'projects' })
      await vi.waitFor(() => expect(host.textContent).toContain(project.name))
    }
    expect(createBoardProject).toHaveBeenCalledTimes(1)
  } finally {
    cleanup()
  }
})


it('桌面外观跟随系统配色模式，配色经本机桥保存后可在重启时恢复', async () => {
  const theme = document.documentElement
  const previousTheme = { theme: theme.dataset.theme, family: theme.dataset.family, palette: theme.dataset.palette }
  const previousScheme = theme.style.colorScheme
  const paletteKey = 'gugu-palette'
  const previousPalette = localStorage.getItem(paletteKey)
  let saved = { theme: 'light', themeFamily: 'glass', palette: 'neutral', defaultView: 'home' }
  const guide = { enabled: true, current_step: 'style', completed_steps: ['locale'], dismissed: false, completed_at: null }
  const updateAppearance = vi.fn(async (patch: Partial<typeof saved>) => {
    saved = { ...saved, ...patch }
    return ok(saved)
  })
  const bridge = {
    clients: async () => ok([]),
    appearance: async () => ok(saved),
    updateAppearance,
    onboarding: async () => ok({ guide }),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })))
  initializeDesktopTheme()
  const first = await mountShell('home', bridge, async () => [])
  try {
    await vi.waitFor(() => expect(first.host.textContent).toContain('引导进行中：style · 已完成 1 步。'))
    expect(theme.dataset.theme).toBe('dark')
    expect(theme.dataset.family).toBe('mono')

    await clickButton(first.host, '打开偏好设置')
    await clickButton(document, 'Harbor')
    await vi.waitFor(() => expect(updateAppearance).toHaveBeenCalledExactlyOnceWith({ palette: 'blue' }))
    expect(theme.dataset.palette).toBe('blue')
  } finally {
    first.cleanup()
  }

  try {
    // 冷启动读取本机桥上的配置，覆盖临时渲染器中的其它配色。
    localStorage.setItem(paletteKey, 'red')
    const restarted = await mountShell('home', bridge, async () => [])
    try {
      await vi.waitFor(() => expect(restarted.host.textContent).toContain('引导进行中'))
      expect(theme.dataset.palette).toBe('blue')
      expect(localStorage.getItem(paletteKey)).toBe('blue')
      expect(updateAppearance).toHaveBeenCalledTimes(1)
    } finally {
      restarted.cleanup()
    }
  } finally {
    for (const [key, value] of Object.entries(previousTheme)) {
      if (value === undefined) delete theme.dataset[key]
      else theme.dataset[key] = value
    }
    theme.style.colorScheme = previousScheme
    if (previousPalette === null) localStorage.removeItem(paletteKey)
    else localStorage.setItem(paletteKey, previousPalette)
  }
})

it('普通浏览器没有桌面桥时显示错误并结束启动忙碌状态', async () => {
  const { host, cleanup } = await mountShell('home', null, async () => [])
  try {
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('请在咕咕桌面应用中打开'))
    const refresh = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === '刷新本地数据')
    expect(refresh?.disabled).toBe(false)
  } finally {
    cleanup()
  }
})

it('桌面日历使用读取的版本编辑，删除确认后可按快捷键撤销和重做', async () => {
  const original = { id: 12, title: '原活动', date: localDayKey(new Date()), version: 1, time: null, endTime: null, description: null }
  let rows = [original]
  let history: 'none' | 'deleted' | 'undone' = 'none'
  const calendar = vi.fn(async () => ok(rows))
  const updateCalendarEvent = vi.fn(async (_id: number, fields: { title: string; version: number }) => {
    const updated = { ...original, title: fields.title, version: fields.version + 1 }
    rows = [updated]
    return ok(updated)
  })
  const deleteCalendarEvent = vi.fn(async () => { rows = []; history = 'deleted'; return ok(null) })
  const undoApply = vi.fn(async () => {
    rows = [{ ...original, title: '更新活动', version: 3 }]
    history = 'undone'
    return ok({})
  })
  const undoRedo = vi.fn(async () => { rows = []; history = 'none'; return ok({}) })
  const { host, cleanup } = await mountShell('calendar', {
    calendar, updateCalendarEvent, deleteCalendarEvent, undoApply, undoRedo,
    clients: async () => ok([]),
    notes: async () => ok([]),
    scheduleTask: async () => ok({ tasks: [], nextBefore: null }),
    undoPreview: async () => ok({
      undo: history === 'deleted' ? { operation_id: 'delete-event', can_undo: true } : null,
      redo: history === 'undone' ? { operation_id: 'delete-event', can_redo: true } : null,
    }),
  }, async () => [])
  const event = () => host.querySelector<HTMLElement>('.sidebar-event[data-event-id="12"]')
  const shortcut = (shiftKey = false) => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey }))
  try {
    await vi.waitFor(() => expect(event()?.textContent).toContain(original.title))
    event()!.click()
    const name = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('.event-form-body .popup-input')
      expect(input?.value).toBe(original.title)
      return input!
    })
    name.value = '更新活动'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await clickButton(document.querySelector('.event-form-body')!, i18n.global.t('common.actions.save'))
    await vi.waitFor(() => expect(event()?.textContent).toContain('更新活动'))
    expect(updateCalendarEvent).toHaveBeenCalledExactlyOnceWith(12, expect.objectContaining({
      version: 1, title: '更新活动', date: original.date,
    }))

    event()!.querySelector<HTMLButtonElement>('.ev-del-btn')!.click()
    const cancel = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('.confirm-dialog-cancel')
      expect(button).not.toBeNull()
      return button!
    })
    cancel.click()
    await vi.waitFor(() => expect(cancel.isConnected).toBe(false))
    expect(deleteCalendarEvent).not.toHaveBeenCalled()
    expect(event()?.textContent).toContain('更新活动')
    event()!.querySelector<HTMLButtonElement>('.ev-del-btn')!.click()
    await clickButton(document, i18n.global.t('calendar.deleteEvent'))
    await vi.waitFor(() => expect(event()).toBeNull())
    expect(deleteCalendarEvent).toHaveBeenCalledExactlyOnceWith(12, 2)

    shortcut()
    await vi.waitFor(() => expect(event()?.textContent).toContain('更新活动'))
    expect(undoApply).toHaveBeenCalledExactlyOnceWith('desktop-calendar', 'delete-event', expect.any(String))
    shortcut(true)
    await vi.waitFor(() => expect(event()).toBeNull())
    expect(undoRedo).toHaveBeenCalledExactlyOnceWith('desktop-calendar', 'delete-event', expect.any(String))
    expect(calendar).toHaveBeenCalledTimes(3)
  } finally {
    cleanup()
  }
})

it('独立项目窗口取消重命名不写入，保存使用本机读取版本', async () => {
  let row = { id: 3, name: '旧项目', version: 2, status: 'pending', stages: [], archived: false }
  const projectDetails = vi.fn(async () => ok(row))
  const updateBoardProject = vi.fn(async (_id: number, version: number, fields: { name: string }) => {
    row = { ...row, ...fields, version: version + 1 }
    return ok(row)
  })
  vi.stubGlobal('guguDesktop', {
    ...Object.fromEntries(projectBoardMethods.map(method => [method, async () => ok(null)])),
    projectDetails, updateBoardProject,
    appearance: async () => ok({ palette: 'neutral' }),
  })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'project-window', components: {} }] })
  await router.push('/')
  const pinia = createPinia()
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(ProjectWindow, { projectId: 3 }).use(pinia).use(router).use(i18n)
    .provide(projectAccessKey, desktopProjectAccess)
    .provide(localPreferencesAccessKey, desktopPreferencesAccess)
  installEnterDirective(app)
  app.mount(host)

  try {
    const input = await vi.waitFor(() => {
      const field = document.querySelector<HTMLInputElement>('.header-name-input')
      expect(field?.value, host.querySelector('[role=alert]')?.textContent ?? '等待项目名称').toBe('旧项目')
      return field!
    })
    const edit = (value: string) => {
      input.focus()
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    edit('取消的项目名')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    input.blur()
    expect(input.value).toBe('旧项目')
    expect(updateBoardProject).not.toHaveBeenCalled()

    edit('新项目')
    input.blur()
    await vi.waitFor(() => expect(updateBoardProject).toHaveBeenCalledExactlyOnceWith(3, 2, { name: '新项目' }))
    const projects = useProjectStore(pinia)
    await vi.waitFor(() => expect(projects.modalProject).toMatchObject({ name: '新项目', version: 3 }))
    await projects.loadModalProject(3)
    expect(projectDetails).toHaveBeenCalledTimes(2)
    expect(input.value).toBe('新项目')
  } finally {
    app.unmount()
    host.remove()
    vi.unstubAllGlobals()
  }
})
