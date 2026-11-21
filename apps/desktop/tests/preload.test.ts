import { expect, it, vi } from 'vitest'
const spies = vi.hoisted(() => ({
  expose: vi.fn(),
  getPathForFile: vi.fn(() => '/synthetic/report.txt'),
  on: vi.fn(),
  removeListener: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, result: [] })),
}))
vi.mock('electron', () => ({
  webUtils: { getPathForFile: spies.getPathForFile },
  contextBridge: { exposeInMainWorld: spies.expose },
  ipcRenderer: { invoke: spies.invoke, on: spies.on, removeListener: spies.removeListener },
}))
import '../src/preload/index.js'

it('Preload 只暴露固定业务函数，不透传任意 channel 或 Electron 对象', async () => {
  const [name, bridge] = spies.expose.mock.calls[0]!
  expect(name).toBe('guguDesktop')
  expect(Object.keys(bridge).sort()).toEqual([
    'addCanvasItem',
    'agentAttachment',
    'agentModel',
    'agentSessions',
    'appearance',
    'auxiliaryModel',
    'bringCanvasItemToFront',
    'calendar',
    'canvasItems',
    'canvasNoteLocation',
    'canvasRelations',
    'canvases',
    'clearAgentAttachments',
    'clearAgentMemory',
    'clients',
    'createBoardProject',
    'createCalendarEvent',
    'createCanvas',
    'createCanvasNote',
    'createCanvasRelation',
    'createClient',
    'createDroppedFileReference',
    'createNote',
    'createProject',
    'createRefNode',
    'deleteBoardProject',
    'deleteCalendarEvent',
    'deleteCanvas',
    'deleteCanvasItem',
    'deleteCanvasRelation',
    'deleteClient',
    'deleteNote',
    'feishuPairing',
    'files',
    'mail',
    'notes',
    'onAgentChatEvent',
    'onAgentRunChanged',
    'onScheduleChanged',
    'onboarding',
    'openDroppedFileReference',
    'projectBoard',
    'projectDetails',
    'projects',
    'qqPairing',
    'readLogs',
    'receipt',
    'remoteAccount',
    'remoteByok',
    'remoteLogin',
    'remoteLogout',
    'renameClient',
    'renameProject',
    'resources',
    'restoreBoardProject',
    'sandboxStatus',
    'scheduleTask',
    'search',
    'startFileDrag',
    'telegramGateway',
    'terminal',
    'undoApply',
    'undoPreview',
    'undoRedo',
    'updateAppearance',
    'updateBoardProject',
    'updateCalendarEvent',
    'updateCanvas',
    'updateCanvasItem',
    'updateCanvasNote',
    'updateNote',
    'wechatPairing',
  ])
  await bridge.files({ action: 'list', path: '' })
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:files:request', { action: 'list', path: '' })
  await bridge.search(['样本'])
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:search:query', ['样本'])
  await bridge.startFileDrag!('personal', '合成.txt', 'data:image/png;base64,synthetic')
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:files:start-drag', 'personal', '合成.txt', 'data:image/png;base64,synthetic')
  await bridge.telegramGateway({ action: 'status' })
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:im:telegram', { action: 'status' })
  await bridge.agentModel({ action: 'test' })
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:agent:model', { action: 'test' })
  await bridge.auxiliaryModel({ action: 'list' })
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:agent:auxiliary-model', { action: 'list' })
  await bridge.agentSessions({ action: 'list' })
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:agent:sessions', { action: 'list' })
  await bridge.agentAttachment!({ action: 'deleteDraft', attachId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:agent:attachment', { action: 'deleteDraft', attachId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })
  await bridge.clearAgentMemory()
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:preferences:memory:clear')
  await bridge.clearAgentAttachments()
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:preferences:attachments:clear-drafts')
  const droppedFile = new File([], 'report.txt')
  await bridge.createDroppedFileReference(droppedFile)
  expect(spies.getPathForFile).toHaveBeenCalledWith(droppedFile)
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:files:dropped-reference', '/synthetic/report.txt')
  await bridge.openDroppedFileReference('synthetic-reference')
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:files:open-dropped-reference', 'synthetic-reference')
  await bridge.resources({ domain: 'skills', action: 'list' })
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:resources:request', { domain: 'skills', action: 'list' })
  await bridge.scheduleTask({ action: 'list' })
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:schedules:request', { action: 'list' })
  const changed = vi.fn()
  const stop = bridge.onScheduleChanged(changed)
  const [channel, listener] = spies.on.mock.calls.at(-1)!
  expect(channel).toBe('gugu:schedules:changed')
  listener({ sender: '仅供主进程使用' })
  expect(changed).toHaveBeenCalledWith()
  stop()
  expect(spies.removeListener).toHaveBeenCalledWith(channel, listener)
  const runChanged = vi.fn()
  const stopRunChanges = bridge.onAgentRunChanged(runChanged)
  const [runChannel, runListener] = spies.on.mock.calls.at(-1)!
  expect(runChannel).toBe('gugu:agent:run-changed')
  runListener({ sender: '仅供主进程使用' }, 42)
  expect(runChanged).toHaveBeenCalledWith(42)
  stopRunChanges()
  expect(spies.removeListener).toHaveBeenCalledWith(runChannel, runListener)
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
  await bridge.projectBoard('archived', 5)
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:projects:board:list', 'archived', 5)
  await bridge.createBoardProject({ name: '合成项目' }, 'cd49e6e8-3c98-479e-91d1-83b57a0d3f1e')
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:projects:board:create', { name: '合成项目' }, 'cd49e6e8-3c98-479e-91d1-83b57a0d3f1e')
  await bridge.updateBoardProject(3, 2, { archived: true })
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:projects:board:update', 3, 2, { archived: true })
  await bridge.renameClient(4, '合成联系人')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:clients:rename', 4, '合成联系人')
  await bridge.deleteClient(4)
  expect(spies.invoke).toHaveBeenCalledWith('gugu:clients:delete', 4)
  const details = { time: '09:30', endTime: '10:45', description: '合成说明' }
  await bridge.createCalendarEvent('合成日程', '2026-12-01', details)
  expect(spies.invoke).toHaveBeenLastCalledWith('gugu:calendar:create', '合成日程', '2026-12-01', details)
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
  await bridge.createCanvasNote(5, { contentMd: '# 标题\n\n正文', color: 'amber', x: 20, y: 30 })
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
