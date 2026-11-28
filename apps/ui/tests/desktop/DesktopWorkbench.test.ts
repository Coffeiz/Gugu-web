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
})
