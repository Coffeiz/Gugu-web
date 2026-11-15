import { expect, it, vi } from 'vitest'
const spies = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, result: [] })),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: spies.expose },
  ipcRenderer: { invoke: spies.invoke },
}))
import '../src/preload/index.js'

it('Preload 只暴露固定业务函数，不透传任意 channel 或 Electron 对象', async () => {
  const [name, bridge] = spies.expose.mock.calls[0]!
  expect(name).toBe('guguDesktop')
  expect(Object.keys(bridge).sort()).toEqual([
    'appearance',
    'calendar',
    'canvasItems',
    'canvases',
    'clients',
    'createCalendarEvent',
    'createCanvas',
    'createCanvasNote',
    'createClient',
    'createNote',
    'createProject',
    'deleteCalendarEvent',
    'deleteCanvas',
    'deleteCanvasItem',
    'deleteClient',
    'deleteNote',
    'notes',
    'onboarding',
    'projects',
    'receipt',
    'renameClient',
    'renameProject',
    'sandboxStatus',
    'undoApply',
    'undoPreview',
    'undoRedo',
    'updateAppearance',
    'updateCalendarEvent',
    'updateCanvas',
    'updateCanvasItem',
    'updateCanvasNote',
    'updateNote',
  ])
  await bridge.onboarding()
  expect(spies.invoke).toHaveBeenCalledWith('gugu:onboarding:state:get')
  await bridge.appearance()
  expect(spies.invoke).toHaveBeenCalledWith('gugu:preferences:appearance:get')
  await bridge.updateAppearance({ theme: 'dark' })
  expect(spies.invoke).toHaveBeenCalledWith('gugu:preferences:appearance:update', { theme: 'dark' })
  await bridge.createProject('合成计划')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:projects:create', '合成计划')
  await bridge.renameProject(3, 2, '合成名称')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:projects:rename', 3, 2, '合成名称')
  await bridge.renameClient(4, '合成联系人')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:clients:rename', 4, '合成联系人')
  await bridge.deleteClient(4)
  expect(spies.invoke).toHaveBeenCalledWith('gugu:clients:delete', 4)
  await bridge.updateCalendarEvent(5, { version: 2, title: '更新日程', date: '2026-12-01' })
  expect(spies.invoke).toHaveBeenCalledWith('gugu:calendar:update', 5, { version: 2, title: '更新日程', date: '2026-12-01' })
  await bridge.deleteCalendarEvent(5, 3)
  expect(spies.invoke).toHaveBeenCalledWith('gugu:calendar:delete', 5, 3)
  await bridge.canvases()
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:canvases:list')
  await bridge.createCanvas('桌面画布')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:canvases:create', '桌面画布')
  await bridge.updateCanvas(5, { title: '更新画布' })
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:canvases:update', 5, { title: '更新画布' })
  await bridge.deleteCanvas(5)
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:canvases:delete', 5)
  await bridge.canvasItems(5)
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:canvases:items:list', 5)
  await bridge.createCanvasNote(5, '# 标题\n\n正文', 'amber', 20, 30)
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:canvases:notes:create', 5, { contentMd: '# 标题\n\n正文', color: 'amber', x: 20, y: 30 })
  await bridge.updateCanvasNote(9, { version: 1, contentMd: '# 更新' })
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:canvases:notes:update', 9, { version: 1, contentMd: '# 更新' })
  await bridge.updateCanvasItem(5, 12, { x: 40, y: 60 })
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:canvases:items:update', 5, 12, { x: 40, y: 60 })
  await bridge.deleteCanvasItem(5, 12)
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:canvases:items:delete', 5, 12)
  await bridge.receipt('合成操作 ID')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:operations:get', '合成操作 ID')
  await bridge.undoApply('合成上下文', '合成撤销', '合成操作')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:undo:apply', '合成上下文', '合成撤销', '合成操作')
  await bridge.undoPreview('合成上下文')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:undo:preview', '合成上下文')
  await bridge.undoRedo('合成上下文', '合成撤销', '合成操作')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:undo:redo', '合成上下文', '合成撤销', '合成操作')
  await bridge.updateNote(9, { version: 2, contentMd: '# 更新' })
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:notes:update', 9, { version: 2, contentMd: '# 更新' })
  await bridge.deleteNote(9)
  expect(spies.invoke).toHaveBeenCalledWith('gugu:mind:notes:delete', 9)
  expect(Object.isFrozen(bridge)).toBe(true)
})
