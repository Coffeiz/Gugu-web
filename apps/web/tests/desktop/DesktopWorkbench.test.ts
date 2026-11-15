// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import DesktopWorkbench from '@/desktop/DesktopWorkbench.vue'

const mocks = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => false) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: mocks.confirmDialog }))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

async function flushUi() {
  await vi.waitFor(async () => {
    await nextTick()
    expect(host?.querySelector('button')?.disabled).toBe(false)
  })
}

function mountWorkbench() {
  const bridge = (window as any).guguDesktop
  if (bridge) {
    bridge.appearance ??= async () => ({ ok: true, result: { theme: 'light', themeFamily: 'glass', palette: 'neutral' } })
    bridge.updateAppearance ??= async (patch: Record<string, unknown>) => ({ ok: true, result: { theme: 'light', themeFamily: 'glass', palette: 'neutral', ...patch } })
    bridge.onboarding ??= async () => ({ ok: true, result: { should_show: false, seed: { seeded: false }, guide: { enabled: false, current_step: 'locale', completed_steps: [], dismissed: false, completed_at: null, should_show: false } } })
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(DesktopWorkbench)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  delete (window as any).guguDesktop
  localStorage.removeItem('gugu.desktop.pending-operation')
  vi.unstubAllGlobals()
})

beforeEach(() => {
  mocks.confirmDialog.mockReset()
  mocks.confirmDialog.mockResolvedValue(false)
})

describe('桌面本地工作台', () => {
  it('外观选择经桌面 IPC 持久化并在工作台启动时恢复', async () => {
    let saved = { theme: 'light', themeFamily: 'glass', palette: 'neutral' }
    const guide = { should_show: true, seed: { seeded: true }, guide: { enabled: true, current_step: 'style', completed_steps: ['locale'], dismissed: false, completed_at: null, should_show: true } }
    const updateAppearance = vi.fn(async (patch: Partial<typeof saved>) => {
      saved = { ...saved, ...patch }
      return { ok: true, result: saved }
    })
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [] }),
      calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [] }), notes: async () => ({ ok: true, result: [] }),
      appearance: async () => ({ ok: true, result: saved }), updateAppearance,
      onboarding: async () => ({ ok: true, result: guide }),
      undoPreview: async () => ({ ok: true, result: { undo: null, redo: null } }),
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench(); await flushUi()
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(element.textContent).toContain('引导进行中：style · 已完成 1 步。')
    const dark = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === '深色')!
    dark.click(); await flushUi()
    expect(updateAppearance).toHaveBeenCalledWith({ theme: 'dark' })
    expect(document.documentElement.dataset.theme).toBe('dark')
    const mono = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Mono')!
    mono.click(); await flushUi()
    expect(updateAppearance).toHaveBeenLastCalledWith({ themeFamily: 'mono' })
    const ink = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Ink')!
    ink.click(); await flushUi()
    expect(updateAppearance).toHaveBeenLastCalledWith({ palette: 'neutral' })
    app?.unmount(); app = undefined; host?.remove(); host = undefined
    mountWorkbench(); await flushUi()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.family).toBe('mono')
    expect(document.documentElement.dataset.palette).toBe('neutral')
  })
  it('从桌面打开画布、添加画布便签并通过版本字段保存正文', async () => {
    const canvas = { id: 2, title: '桌面画布', projectId: null, data: {}, createdAt: '', updatedAt: '' }
    const items = [{ id: 8, canvasId: 2, nodeId: 9, x: 0, y: 0, w: null, h: null, z: 0, collapsed: false, data: {}, refData: null,
      node: { id: 9, kind: 'canvas_note', title: '标题', contentMd: '# 标题\n\n旧正文', color: 'amber', version: 1 }, createdAt: '', updatedAt: '' }]
    const createCanvasNote = vi.fn(async (_canvasId: number, contentMd: string, color?: string, x?: number, y?: number) => {
      const item = { ...items[0]!, id: 10, nodeId: 11, x: x ?? 0, y: y ?? 0, node: { ...items[0]!.node, id: 11, contentMd, color: color ?? null } }
      items.push(item)
      return { ok: true, result: item }
    })
    const updateCanvasNote = vi.fn(async (nodeId: number, fields: { version: number; contentMd?: string }) => {
      const item = items.find(row => row.nodeId === nodeId)!
      item.node = { ...item.node, contentMd: fields.contentMd!, version: fields.version + 1 }
      return { ok: true, result: item.node }
    })
    const updateCanvasItem = vi.fn(async (_canvasId: number, itemId: number, body: { x?: number; y?: number }) => {
      const item = items.find(row => row.id === itemId)!
      item.x = body.x ?? item.x; item.y = body.y ?? item.y
      return { ok: true, result: item }
    })
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [] }),
      calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [canvas] }), notes: async () => ({ ok: true, result: [] }),
      canvasItems: async (canvasId: number) => ({ ok: true, result: canvasId === canvas.id ? [...items] : [] }),
      createCanvasNote, updateCanvasNote, updateCanvasItem, updateCanvas: async () => ({ ok: true, result: canvas }),
      createCanvas: async () => ({ ok: true, result: canvas }), deleteCanvas: async () => ({ ok: true, result: null }),
      createCalendarEvent: async () => ({ ok: true, result: {} }), createNote: async () => ({ ok: true, result: {} }),
      undoPreview: async () => ({ ok: true, result: { undo: null, redo: null } }),
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench(); await flushUi()
    await vi.waitFor(() => expect(element.textContent).toContain('画布便签'))
    const create = element.querySelector<HTMLTextAreaElement>('textarea[aria-labelledby="canvas-note-content-label"]')!
    create.value = '# 新卡片\n\n新内容'; create.dispatchEvent(new Event('input', { bubbles: true }))
    create.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(createCanvasNote).toHaveBeenCalledWith(2, '# 新卡片\n\n新内容', 'amber', 280, 0)
    expect(element.textContent).toContain('新内容')
    Array.from(element.querySelectorAll<HTMLButtonElement>('button[aria-label^="将便签向右移动"]')).at(-1)!.click()
    await flushUi()
    expect(updateCanvasItem).toHaveBeenCalledWith(2, 10, { x: 320, y: 0 })
    Array.from(element.querySelectorAll('button')).filter(button => button.textContent?.includes('编辑便签')).at(-1)!.click(); await nextTick()
    const edit = element.querySelector<HTMLTextAreaElement>('textarea[aria-labelledby="canvas-note-edit-10"]')!
    edit.value = '# 新卡片\n\n已编辑'; edit.dispatchEvent(new Event('input', { bubbles: true }))
    edit.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(updateCanvasNote).toHaveBeenCalledWith(11, { version: 1, contentMd: '# 新卡片\n\n已编辑' })
    expect(element.textContent).toContain('已编辑')
  })
  it('便签编辑提交读取时的版本并在保存后重读', async () => {
    const rows = [{ id: 9, title: '标题', contentMd: '# 标题\n\n旧正文', color: null, version: 2 }]
    const updateNote = vi.fn(async (id: number, fields: { version: number; contentMd?: string }) => {
      rows[0] = { ...rows[0]!, id, contentMd: fields.contentMd!, version: fields.version + 1 }
      return { ok: true, result: rows[0] }
    })
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [] }),
      calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [] }), createCalendarEvent: async () => ({ ok: true, result: {} }),
      notes: async () => ({ ok: true, result: [...rows] }), createNote: async () => ({ ok: true, result: rows[0] }), updateNote,
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench(); await flushUi()
    Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes('编辑'))!.click(); await nextTick()
    const textarea = element.querySelector<HTMLTextAreaElement>('textarea[aria-labelledby="note-edit-label"]')!
    textarea.value = '# 标题\n\n新正文'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(updateNote).toHaveBeenCalledWith(9, { version: 2, contentMd: '# 标题\n\n新正文' })
    expect(element.textContent).toContain('新正文')
    expect(element.textContent).toContain('v3')
  })
  it('便签删除先确认，取消不写入，确认后刷新已删除列表', async () => {
    const rows = [{ id: 9, title: '标题', contentMd: '# 标题', color: null, version: 1 }]
    const saved = { ...rows[0]! }
    let deleted = false
    const deleteNote = vi.fn(async () => { deleted = true; rows.splice(0); return { ok: true, result: null } })
    const undoApply = vi.fn(async () => { deleted = false; rows.push(saved); return { ok: true, result: {} } })
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [] }),
      calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [] }), createCalendarEvent: async () => ({ ok: true, result: {} }),
      notes: async () => ({ ok: true, result: [...rows] }), createNote: async () => ({ ok: true, result: rows[0] }),
      updateNote: async () => ({ ok: true, result: rows[0] }), deleteNote,
      undoPreview: async () => ({ ok: true, result: deleted
        ? { available: true, undo: { operation_id: 'note-delete-op', can_undo: true }, redo_available: false, redo: null }
        : { available: false, undo: null, redo_available: false, redo: null } }),
      undoApply, undoRedo: async () => ({ ok: true, result: {} }),
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench(); await flushUi()
    const remove = () => Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === '删除')!
    remove().click(); await flushUi()
    expect(mocks.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }))
    expect(deleteNote).not.toHaveBeenCalled()
    mocks.confirmDialog.mockResolvedValueOnce(true)
    remove().click(); await flushUi()
    expect(deleteNote).toHaveBeenCalledWith(9)
    expect(element.textContent).toContain('这里会保存你的便签')
    const undo = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes('撤销最近便签或画布操作'))!
    undo.click(); await flushUi()
    expect(undoApply).toHaveBeenCalledWith('desktop-mind', 'note-delete-op', expect.any(String))
    expect(element.textContent).toContain('# 标题')
  })
  it('联系人重命名支持取消并在保存后重读', async () => {
    const rows = [{ id: 4, name: '旧联系人' }]
    const renameClient = vi.fn(async (id: number, name: string) => { rows[0] = { id, name }; return { ok: true, result: rows[0] } })
    ;(window as any).guguDesktop = { projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [...rows] }), calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [] }), createCalendarEvent: async () => ({ ok: true, result: { id: 1, title: '测试', date: '2026-01-01', version: 1 } }), notes: async () => ({ ok: true, result: [] }), createNote: async () => ({ ok: true, result: { id: 1, title: null, contentMd: '', color: null, version: 1 } }), renameClient, sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }) }
    const element = mountWorkbench(); await flushUi()
    const button = () => Array.from(element.querySelectorAll('button')).find(item => item.textContent?.includes('重命名'))!
    button().click(); await nextTick()
    Array.from(element.querySelectorAll('button')).find(item => item.textContent?.includes('取消'))!.click(); await nextTick()
    expect(renameClient).not.toHaveBeenCalled()
    button().click(); await nextTick()
    const input = element.querySelector<HTMLInputElement>('input[aria-label="联系人名称"]')!
    input.value = '新联系人'; input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(renameClient).toHaveBeenCalledWith(4, '新联系人')
    expect(element.textContent).toContain('新联系人')
  })
  it('联系人删除先确认，取消不写入，确认后重读列表', async () => {
    const rows = [{ id: 7, name: '待删除联系人' }]
    const deleteClient = vi.fn(async () => { rows.splice(0); return { ok: true, result: null } })
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [...rows] }),
      createClient: async () => ({ ok: true, result: rows[0] }), renameClient: async () => ({ ok: true, result: rows[0] }), deleteClient,
      calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [] }), createCalendarEvent: async () => ({ ok: true, result: {} }),
      notes: async () => ({ ok: true, result: [] }), createNote: async () => ({ ok: true, result: {} }),
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench(); await flushUi()
    const remove = () => Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === '删除')!
    remove().click(); await flushUi()
    expect(mocks.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }))
    expect(deleteClient).not.toHaveBeenCalled()
    mocks.confirmDialog.mockResolvedValueOnce(true)
    remove().click(); await flushUi()
    expect(deleteClient).toHaveBeenCalledWith(7)
    expect(element.textContent).toContain('这里会保存你的联系人')
  })
  it('日程按读取版本编辑，删除需确认，撤销和重做会重读 SQLite 列表', async () => {
    const rows = [{ id: 12, title: '原日程', date: '2026-12-01', version: 1 }]
    let history: 'updated' | 'deleted' | 'undone' | 'redone' = 'updated'
    const updateCalendarEvent = vi.fn(async (id: number, body: { version: number; title?: string; date?: string }) => {
      rows[0] = { id, title: body.title!, date: body.date!, version: body.version + 1 }
      history = 'updated'
      return { ok: true, result: rows[0] }
    })
    const deleteCalendarEvent = vi.fn(async () => { history = 'deleted'; rows.splice(0); return { ok: true, result: null } })
    const undoApply = vi.fn(async () => { history = 'undone'; rows.push({ id: 12, title: '更新日程', date: '2026-12-03', version: 4 }); return { ok: true, result: {} } })
    const undoRedo = vi.fn(async () => { history = 'redone'; rows.splice(0); return { ok: true, result: {} } })
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [] }),
      calendar: async () => ({ ok: true, result: [...rows] }), canvases: async () => ({ ok: true, result: [] }), createCalendarEvent: async () => ({ ok: true, result: rows[0] }),
      updateCalendarEvent, deleteCalendarEvent,
      notes: async () => ({ ok: true, result: [] }), createNote: async () => ({ ok: true, result: {} }),
      undoPreview: async () => ({ ok: true, result: history === 'deleted'
        ? { available: true, undo: { operation_id: 'delete-event-op', can_undo: true }, redo_available: false, redo: null }
        : history === 'undone'
          ? { available: true, undo: null, redo_available: true, redo: { operation_id: 'delete-event-op', can_redo: true } }
          : { available: history !== 'redone', undo: { operation_id: 'update-event-op', can_undo: history !== 'redone' }, redo_available: false, redo: null } }),
      undoApply, undoRedo,
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench(); await flushUi()
    Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes('编辑'))!.click(); await nextTick()
    const title = element.querySelector<HTMLInputElement>('input[aria-labelledby="calendar-edit-title-label"]')!
    title.value = '更新日程'; title.dispatchEvent(new Event('input', { bubbles: true }))
    const date = element.querySelector<HTMLInputElement>('input[aria-labelledby="calendar-edit-date-label"]')!
    date.value = '2026-12-03'; date.dispatchEvent(new Event('input', { bubbles: true }))
    title.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushUi()
    expect(updateCalendarEvent).toHaveBeenCalledWith(12, { version: 1, title: '更新日程', date: '2026-12-03' })
    const remove = () => Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === '删除')!
    remove().click(); await flushUi()
    expect(deleteCalendarEvent).not.toHaveBeenCalled()
    mocks.confirmDialog.mockResolvedValueOnce(true)
    remove().click(); await flushUi()
    expect(deleteCalendarEvent).toHaveBeenCalledWith(12, 2)
    Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes('撤销最近日历操作'))!.click(); await flushUi()
    expect(undoApply).toHaveBeenCalledWith('desktop-calendar', 'delete-event-op', expect.any(String))
    expect(element.textContent).toContain('更新日程')
    Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes('重做最近日历操作'))!.click(); await flushUi()
    expect(undoRedo).toHaveBeenCalledWith('desktop-calendar', 'delete-event-op', expect.any(String))
    expect(element.textContent).toContain('这里会显示你的日程')
  })
  it('画布创建和改名后可软删除，确认撤销与重做都重读 Core 列表', async () => {
    const rows: { id: number; title: string; projectId: number | null; data: Record<string, unknown>; createdAt: string; updatedAt: string }[] = []
    let history: 'empty' | 'created' | 'updated' | 'deleted' | 'undone' | 'redone' = 'empty'
    const saved = { id: 21, title: '更新画布', projectId: null, data: {}, createdAt: '2026-11-15T00:00:00+00:00', updatedAt: '2026-11-15T00:00:00+00:00' }
    const createCanvas = vi.fn(async (title: string) => {
      const row = { ...saved, title: title || '未命名画布' }
      rows.push(row); history = 'created'
      return { ok: true, result: row }
    })
    const updateCanvas = vi.fn(async (id: number, body: { title: string }) => {
      rows[0] = { ...rows[0]!, id, title: body.title }; history = 'updated'
      return { ok: true, result: rows[0] }
    })
    const deleteCanvas = vi.fn(async () => { rows.splice(0); history = 'deleted'; return { ok: true, result: null } })
    const undoApply = vi.fn(async () => { rows.push(saved); history = 'undone'; return { ok: true, result: {} } })
    const undoRedo = vi.fn(async () => { rows.splice(0); history = 'redone'; return { ok: true, result: {} } })
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [] }),
      calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [...rows] }),
      canvasItems: async () => ({ ok: true, result: [] }),
      createCalendarEvent: async () => ({ ok: true, result: {} }), notes: async () => ({ ok: true, result: [] }),
      createNote: async () => ({ ok: true, result: {} }), createCanvas, updateCanvas, deleteCanvas,
      undoPreview: async () => ({ ok: true, result: history === 'deleted'
        ? { undo: { operation_id: 'canvas-delete-op', can_undo: true }, redo: null }
        : history === 'undone'
          ? { undo: null, redo: { operation_id: 'canvas-delete-op', can_redo: true } }
          : history === 'created' || history === 'updated'
            ? { undo: { operation_id: 'canvas-update-op', can_undo: true }, redo: null }
            : { undo: null, redo: null } }),
      undoApply, undoRedo,
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench(); await flushUi()
    const section = element.querySelector<HTMLElement>('[aria-labelledby="desktop-canvases"]')!
    const title = section.querySelector<HTMLInputElement>('input[aria-labelledby="canvas-title-label"]')!
    title.value = '计划画布'; title.dispatchEvent(new Event('input', { bubbles: true }))
    title.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushUi()
    expect(createCanvas).toHaveBeenCalledWith('计划画布')
    expect(section.textContent).toContain('计划画布')
    Array.from(section.querySelectorAll('button')).find(button => button.textContent?.includes('重命名'))!.click(); await nextTick()
    const edited = section.querySelector<HTMLInputElement>('input[aria-label="画布标题"]')!
    edited.value = '更新画布'; edited.dispatchEvent(new Event('input', { bubbles: true }))
    edited.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flushUi()
    expect(updateCanvas).toHaveBeenCalledWith(21, { title: '更新画布' })
    const remove = () => Array.from(section.querySelectorAll('button')).find(button => button.textContent?.trim() === '删除')!
    remove().click(); await flushUi()
    expect(deleteCanvas).not.toHaveBeenCalled()
    mocks.confirmDialog.mockResolvedValueOnce(true)
    remove().click(); await flushUi()
    expect(deleteCanvas).toHaveBeenCalledWith(21)
    Array.from(section.querySelectorAll('button')).find(button => button.textContent?.includes('撤销最近便签或画布操作'))!.click(); await flushUi()
    expect(undoApply).toHaveBeenCalledWith('desktop-mind', 'canvas-delete-op', expect.any(String))
    expect(section.textContent).toContain('更新画布')
    Array.from(section.querySelectorAll('button')).find(button => button.textContent?.includes('重做最近便签或画布操作'))!.click(); await flushUi()
    expect(undoRedo).toHaveBeenCalledWith('desktop-mind', 'canvas-delete-op', expect.any(String))
    expect(section.textContent).toContain('创建第一个画布')
  })
  it('重命名提交当前版本并重读列表，取消不发请求', async () => {
    const rows = [{ id: 3, name: '旧项目', version: 2 }]
    const renameProject = vi.fn(async (id: number, version: number, name: string) => {
      rows[0] = { id, name, version: version + 1 }
      return { ok: true, result: rows[0] }
    })
    ;(window as any).guguDesktop = { projects: async () => ({ ok: true, result: [...rows] }), clients: async () => ({ ok: true, result: [] }), calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [] }), createCalendarEvent: async () => ({ ok: true, result: { id: 1, title: '测试', date: '2026-01-01', version: 1 } }), notes: async () => ({ ok: true, result: [] }), createNote: async () => ({ ok: true, result: { id: 1, title: null, contentMd: '', color: null, version: 1 } }), renameProject, sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }) }
    const element = mountWorkbench()
    await flushUi()
    const button = () => Array.from(element.querySelectorAll('button')).find(item => item.textContent?.includes('重命名'))!
    button().click(); await nextTick()
    Array.from(element.querySelectorAll('button')).find(item => item.textContent?.includes('取消'))!.click(); await nextTick()
    expect(renameProject).not.toHaveBeenCalled()
    button().click(); await nextTick()
    const input = element.querySelector<HTMLInputElement>('input[aria-label="项目名称"]')!
    input.value = '新项目'; input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(renameProject).toHaveBeenCalledWith(3, 2, '新项目')
    expect(element.textContent).toContain('新项目')
    expect(element.textContent).toContain('v3')
  })
  it('创建后从 Core 重读列表，不依赖 Web 登录或 HTTP', async () => {
    const rows: { id: number; name: string; version: number }[] = []
    const createProject = vi.fn(async (name: string) => { rows.push({ id: 1, name, version: 1 }); return { ok: true, result: rows[0] } })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [...rows] }), createProject,
      clients: async () => ({ ok: true, result: [] }),
      calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [] }), createCalendarEvent: async () => ({ ok: true, result: { id: 1, title: '测试', date: '2026-01-01', version: 1 } }),
      notes: async () => ({ ok: true, result: [] }), createNote: async () => ({ ok: true, result: { id: 1, title: null, contentMd: '', color: null, version: 1 } }),
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench()
    await flushUi()
    const input = element.querySelector<HTMLInputElement>('#project-name')!
    input.value = '本地项目'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(element.textContent).toContain('本地项目')
    expect(element.textContent).toContain('Core 已连接')
    expect(createProject).toHaveBeenCalledWith('本地项目')
    expect(input.value).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('普通浏览器缺少原生桥时显示明确错误并结束忙碌状态', async () => {
    const element = mountWorkbench()
    await flushUi()
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('请在咕咕桌面应用中打开')
    expect(element.querySelector('button')?.disabled).toBe(false)
  })

  it('未知写入结果保留操作标识和输入，结束忙碌且不自动再次提交', async () => {
    const createProject = vi.fn(async () => ({ ok: false, error: { code: 'unknown_result', message: '结果未确认，请查询操作收据', operationId: '00000000-0000-4000-8000-000000000001' } }))
    ;(window as any).guguDesktop = { projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [] }), calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [] }), createCalendarEvent: async () => ({ ok: true, result: { id: 1, title: '测试', date: '2026-01-01', version: 1 } }), notes: async () => ({ ok: true, result: [] }), createNote: async () => ({ ok: true, result: { id: 1, title: null, contentMd: '', color: null, version: 1 } }), createProject, sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }) }
    const element = mountWorkbench()
    await flushUi()
    const input = element.querySelector<HTMLInputElement>('#project-name')!
    input.value = '待确认计划'; input.dispatchEvent(new Event('input', { bubbles: true }))
    element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(createProject).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('待确认计划')
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('00000000-0000-4000-8000-000000000001')
    expect(localStorage.getItem('gugu.desktop.pending-operation')).toBe('00000000-0000-4000-8000-000000000001')
    expect(element.textContent).toContain('查询待确认操作')
    expect(element.querySelector('button')?.disabled).toBe(false)
  })

  it('重启后查到持久收据时刷新权威列表并清除待确认标识', async () => {
    localStorage.setItem('gugu.desktop.pending-operation', '00000000-0000-4000-8000-000000000001')
    const receipt = vi.fn(async () => ({ ok: true, result: { method: 'projects.create', result: { id: 1 } } }))
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [{ id: 1, name: '收据中的项目', version: 1 }] }),
      clients: async () => ({ ok: true, result: [] }),
      calendar: async () => ({ ok: true, result: [] }), canvases: async () => ({ ok: true, result: [] }), createCalendarEvent: async () => ({ ok: true, result: { id: 1, title: '测试', date: '2026-01-01', version: 1 } }),
      notes: async () => ({ ok: true, result: [] }), createNote: async () => ({ ok: true, result: { id: 1, title: null, contentMd: '', color: null, version: 1 } }),
      receipt,
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench()
    await flushUi()
    expect(receipt).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    expect(element.textContent).toContain('收据中的项目')
    expect(localStorage.getItem('gugu.desktop.pending-operation')).toBeNull()
  })
})
