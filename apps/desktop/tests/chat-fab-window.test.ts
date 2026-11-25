import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const state = vi.hoisted(() => ({
  cursor: { x: 0, y: 0 },
  attach: new Map<string, (...args: unknown[]) => unknown>(),
  events: new Map<string, (...args: unknown[]) => void>(),
  windows: [] as WindowStub[],
  windowTypes: [] as (string | undefined)[],
}))

class WindowStub extends EventEmitter {
  private readonly frame = { url: '' }
  readonly webContents = Object.assign(new EventEmitter(), {
    send: vi.fn(), isLoadingMainFrame: () => false, mainFrame: this.frame,
  })
  x = 0
  y = 0
  width = 72
  height = 72
  resizable = false
  minimum = { width: 1, height: 1 }
  visible = false
  minimized = false
  pinned = false
  destroyed = false
  constructor(public parent: WindowStub | null = null) { super() }
  asWindow() { return this as unknown as BrowserWindow }
  getContentBounds() { return { x: this.x, y: this.y, width: 960, height: 600 } }
  getBounds() { return { x: this.x, y: this.y, width: this.width, height: this.height } }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  isMinimized() { return this.minimized }
  getParentWindow() { return this.parent }
  setParentWindow(parent: WindowStub | null) { this.parent = parent }
  setVisibleOnAllWorkspaces = vi.fn()
  setAlwaysOnTop(pinned: boolean) { this.pinned = pinned }
  setPosition(x: number, y: number) { this.x = x; this.y = y }
  setBounds({ x, y, width, height }: { x: number; y: number; width: number; height: number }) {
    this.setPosition(x, y)
    this.width = width
    this.height = height
  }
  focus = vi.fn()
  setIgnoreMouseEvents = vi.fn()
  setResizable(value: boolean) { this.resizable = value }
  getMinimumSize() { return [this.minimum.width, this.minimum.height] }
  setMinimumSize(width: number, height: number) { this.minimum = { width, height } }
  show() { this.visible = true }
  showInactive() { this.visible = true }
  hide() { this.visible = false }
  destroy() { this.destroyed = true; this.emit('closed') }
  async loadURL(url: string) { this.frame.url = url }
  sender() { return { sender: this.webContents, senderFrame: this.frame } }
}

vi.mock('electron', () => ({
  BrowserWindow: class extends WindowStub {
    constructor(options: { parent: WindowStub; type?: string }) {
      super(options.parent)
      state.windows.push(this)
      state.windowTypes.push(options.type)
    }
  },
  ipcMain: {
    handle: (channel: string, callback: (...args: unknown[]) => unknown) => state.attach.set(channel, callback),
    on: (channel: string, callback: (...args: unknown[]) => void) => state.events.set(channel, callback),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1600, height: 900 } }],
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }),
  },
}))

vi.mock('../src/main/windows.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/windows.js')>(),
  secureWindow: () => {},
}))

const { registerChatFabWindow } = await import('../src/main/chat-fab-window.js')
import { chatFabChannels as channels } from '../src/chat-fab-channels.js'

const uiUrl = 'gugu-desktop://app/desktop.html'

afterEach(() => {
  vi.useRealTimers()
  state.windows.length = 0
  state.windowTypes.length = 0
  state.attach.clear()
  state.events.clear()
})

it('聊天面板跟随悬浮球，脱离时置顶并在拖回后继续随主窗显示', async () => {
  vi.useFakeTimers()
  const main = new WindowStub()
  await main.loadURL(uiUrl)
  main.visible = true
  const manager = registerChatFabWindow({ uiUrl, preload: '合成预加载', panelPreload: '合成面板预加载', prewarm: false, enabled: () => true,
    mainWindow: () => main.asWindow() })
  manager.watchMain(main.asWindow())
  const attaching = state.attach.get(channels.attach)!(main.sender())
  const ball = state.windows[0]!
  const gesture = (action: string) => state.events.get(channels.gesture)!(ball.sender(), action, state.cursor.x, state.cursor.y)
  gesture('ready')
  await expect(attaching).resolves.toBe(true)
  const docked = { x: ball.x, y: ball.y }
  expect(ball.visible).toBe(true)

  main.minimized = true
  main.emit('minimize')
  expect(ball.visible).toBe(false)
  main.minimized = false
  main.emit('restore')

  state.cursor = { x: ball.x + 36, y: ball.y + 36 }
  gesture('down')
  state.cursor = { x: 1150, y: 650 }
  gesture('up')
  expect(ball.parent).toBeNull()
  expect(ball.pinned).toBe(true)
  expect(manager.hasVisibleDetachedWindow()).toBe(true)
  main.minimized = true
  main.emit('minimize')
  main.x = 40
  main.emit('move')
  expect(ball.visible).toBe(true)
  expect(ball.x + 36).toBe(1150)

  gesture('down')
  gesture('up')
  const panel = state.windows[1]!
  const nativeType = process.platform === 'darwin' ? 'panel' : undefined
  expect(state.windowTypes).toEqual([nativeType, nativeType])
  if (process.platform === 'darwin') {
    for (const window of [ball, panel]) {
      expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(false, {
        visibleOnFullScreen: false, skipTransformProcessType: true,
      })
    }
  }
  state.events.get(channels.panelReady)!(panel.sender())
  expect(main.minimized).toBe(true)
  expect(panel.visible).toBe(true)
  expect(panel.pinned).toBe(true)
  expect(panel.webContents.send).toHaveBeenCalledWith(channels.openChat)
  const latestGeometry = () => panel.webContents.send.mock.calls.filter(([channel]) => channel === channels.panelGeometry).at(-1)?.[1]
  const compact = latestGeometry().target
  const stableFrame = panel.getBounds()
  expect(ball.y + 11 - (compact.y + compact.height - 4)).toBe(10)
  expect(compact.x + compact.width - 4).toBe(ball.x + ball.width - 11)
  state.events.get(channels.panelEntered)!(panel.sender())
  const setExpanded = (expanded: boolean) => {
    state.events.get(channels.panelExpanded)!(panel.sender(), expanded)
    const [channel, geometry] = panel.webContents.send.mock.lastCall ?? []
    expect(channel).toBe(channels.panelGeometry)
    expect(geometry).toMatchObject({ duration: 420 })
    expect(panel.getBounds()).toEqual(geometry.frame)
    return geometry as { id: number; target: ReturnType<WindowStub['getBounds']> }
  }
  const finishGeometry = (id: number) => state.events.get(channels.panelGeometryDone)!(panel.sender(), id)
  const expansion = setExpanded(true)
  expect(panel.resizable).toBe(false)
  expect(panel.getBounds()).toEqual(stableFrame)
  expect(expansion.target.x + expansion.target.width - 4).toBe(ball.x + ball.width - 11)
  expect(expansion.target.y + expansion.target.height - 4).toBe(ball.y + ball.height - 11)
  finishGeometry(expansion.id)
  expect(panel.resizable).toBe(true)
  expect(panel.width).toBeGreaterThan(compact.width)
  expect(panel.minimum).toEqual({ width: 480, height: 360 })
  expect(expansion.target.height).toBeGreaterThan(expansion.target.width)
  const previous = panel.getBounds()
  const anchorAtWidth = ball.getBounds()
  const nativeBounds = { ...previous, x: previous.x + previous.width - 690, width: 690 }
  const preventDefault = vi.fn()
  panel.emit('will-resize', { preventDefault }, nativeBounds)
  expect(preventDefault).not.toHaveBeenCalled()
  expect(panel.getBounds()).toEqual(previous)
  panel.setBounds(nativeBounds)
  panel.emit('resize')
  expect(ball.getBounds()).toEqual(anchorAtWidth)
  panel.emit('resized')
  const beforeMove = ball.getBounds()
  panel.emit('will-move')
  panel.setPosition(panel.x + 20, panel.y + 15)
  panel.emit('move')
  panel.emit('moved')
  expect(ball.getBounds()).toMatchObject({ x: beforeMove.x + 20, y: beforeMove.y + 15 })
  state.cursor = { x: ball.x + 36, y: ball.y + 36 }
  const contraction = setExpanded(false)
  finishGeometry(expansion.id)
  expect(latestGeometry().settled).toBeUndefined()
  finishGeometry(contraction.id)
  expect(panel.resizable).toBe(false)
  expect(latestGeometry().target.width).toEqual(compact.width)
  expect(panel.getBounds()).toEqual(latestGeometry().frame)
  finishGeometry(setExpanded(true).id)
  expect(latestGeometry().target).toMatchObject({ width: 690, height: previous.height })

  main.minimized = false
  main.emit('restore')

  gesture('down')
  state.cursor = { x: 750, y: 430 }
  gesture('move')
  expect(panel.y + panel.height - 4).toBe(ball.y + ball.height - 11)
  expect(panel.x + panel.width - 4).toBe(ball.x + ball.width - 11)
  gesture('up')
  await vi.advanceTimersByTimeAsync(250)
  expect(ball.parent).toBe(main)
  expect(manager.hasVisibleDetachedWindow()).toBe(false)
  expect(ball.pinned).toBe(false)
  expect(ball.getBounds()).toMatchObject({ x: docked.x + 40, y: docked.y })
  expect(panel.parent).toBe(main)
  expect(panel.pinned).toBe(false)
  expect(panel.visible).toBe(true)
  expect(latestGeometry().target).toEqual({ x: 412, y: 12, width: 576, height: 576 })
  expect(panel.resizable).toBe(false)
  finishGeometry(latestGeometry().id)
  const dockedPanelBounds = panel.getBounds()
  const dockedGeometry = latestGeometry()
  const beforeDockedDrag = ball.getBounds()
  state.cursor = { x: ball.x + 36, y: ball.y + 36 }
  gesture('down')
  state.cursor = { x: 500, y: 480 }
  gesture('move')
  expect(panel.parent).toBe(main)
  expect(panel.getBounds()).toEqual({
    ...dockedPanelBounds,
    x: dockedPanelBounds.x + ball.x - beforeDockedDrag.x,
    y: dockedPanelBounds.y + ball.y - beforeDockedDrag.y,
  })
  expect(latestGeometry()).toBe(dockedGeometry)
  gesture('up')
  await vi.advanceTimersByTimeAsync(250)
  expect(latestGeometry().target).toEqual(dockedGeometry.target)
  main.minimized = true
  main.emit('minimize')
  expect(panel.visible).toBe(false)
})

it('从主窗拖出紧凑聊天后，首次展开复用脱离时准备的原生视口', async () => {
  const main = new WindowStub()
  await main.loadURL(uiUrl)
  main.y = 100
  main.visible = true
  registerChatFabWindow({ uiUrl, preload: '合成预加载', panelPreload: '合成面板预加载', prewarm: false, enabled: () => true,
    mainWindow: () => main.asWindow() })
  const attaching = state.attach.get(channels.attach)!(main.sender())
  const ball = state.windows[0]!
  const gesture = (action: string, x = 0, y = 0) => state.events.get(channels.gesture)!(ball.sender(), action, x, y)
  gesture('ready')
  await attaching
  gesture('open')
  const panel = state.windows[1]!
  const notify = (channel: string, value?: unknown) => state.events.get(channel)!(panel.sender(), value)
  notify(channels.panelReady)
  notify(channels.panelEntered)
  gesture('down', ball.x + 36, ball.y + 36)
  gesture('move', 1200, 800)
  const beforeRelease = panel.getBounds()
  gesture('up', 1200, 800)
  expect(panel.getBounds()).toEqual(beforeRelease)
  const detachedFrame = panel.getBounds()
  expect(panel.parent).toBeNull()
  notify(channels.panelExpanded, true)
  const [channel, geometry] = panel.webContents.send.mock.lastCall ?? []
  expect(channel).toBe(channels.panelGeometry)
  expect(geometry).toMatchObject({ duration: 420, frame: detachedFrame })
  expect(panel.getBounds()).toEqual(detachedFrame)
  notify(channels.panelGeometryDone, geometry.id)
  expect(panel.resizable).toBe(true)
  expect(panel.getBounds()).toEqual(geometry.target)
  expect(panel.getBounds()).toEqual(detachedFrame)
  expect(panel.width).toBe(612)
  expect(panel.height).toBeGreaterThan(panel.width)
  notify(channels.panelExpanded, false)
  const collapse = panel.webContents.send.mock.lastCall?.[1]
  notify(channels.panelGeometryDone, collapse.id)
  const compact = panel.webContents.send.mock.lastCall?.[1].target
  const oldBall = ball.getBounds()
  const nativeMove = panel.setPosition.bind(panel)
  panel.setPosition = (x, y) => nativeMove(x, Math.max(31, y))
  gesture('down', oldBall.x + 36, oldBall.y + 36)
  gesture('move', 700, 630)
  const drag = panel.webContents.send.mock.lastCall?.[1]
  expect(panel.y).toBe(31)
  expect(drag.target.y).toBe(compact.y + ball.y - oldBall.y)
  expect(drag.frame.y).toBe(panel.y)
})

it('聊天面板再次点击时播放退场动画，旧退场通知不会隐藏重新打开的面板', async () => {
  const main = new WindowStub()
  await main.loadURL(uiUrl)
  main.visible = true
  registerChatFabWindow({ uiUrl, preload: '合成预加载', panelPreload: '合成面板预加载', prewarm: false, enabled: () => true,
    mainWindow: () => main.asWindow() })
  const attaching = state.attach.get(channels.attach)!(main.sender())
  const ball = state.windows[0]!
  const gesture = (action: string) => state.events.get(channels.gesture)!(ball.sender(), action, state.cursor.x, state.cursor.y)
  gesture('ready')
  await attaching
  gesture('open')
  const panel = state.windows[1]!
  const notify = (channel: string) => state.events.get(channel)!(panel.sender())
  notify(channels.panelReady)
  expect(panel.visible).toBe(true)
  expect(panel.webContents.send.mock.calls.filter(([channel]) => channel === channels.openChat)).toHaveLength(1)
  expect(panel.focus).not.toHaveBeenCalled()
  notify(channels.panelEntered)
  expect(panel.focus).toHaveBeenCalledOnce()

  expect(panel.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true)
  gesture('down')
  gesture('up')
  expect(panel.webContents.send).toHaveBeenLastCalledWith(channels.closeChat, true)
  expect(panel.visible).toBe(true)
  notify(channels.panelClosing)
  expect(panel.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
  expect(panel.visible).toBe(true)
  gesture('open')
  expect(panel.webContents.send.mock.calls.filter(([channel]) => channel === channels.openChat)).toHaveLength(2)
  notify(channels.panelClose)
  expect(panel.visible).toBe(true)

  notify(channels.panelClosing)
  notify(channels.panelClose)
  expect(panel.visible).toBe(false)
})

it('只有悬浮球可以接收系统文件，聊天面板就绪后收到引用', async () => {
  const main = new WindowStub()
  await main.loadURL(uiUrl)
  main.visible = true
  const reference = { type: 'file' as const, id: 'drop-example', label: '说明.md' }
  const createDroppedReference = vi.fn(async () => reference)
  registerChatFabWindow({ uiUrl, preload: '合成预加载', panelPreload: '合成面板预加载', prewarm: false,
    enabled: () => true, mainWindow: () => main.asWindow(), createDroppedReference })
  const attaching = state.attach.get(channels.attach)!(main.sender())
  const ball = state.windows[0]!
  state.events.get(channels.gesture)!(ball.sender(), 'ready')
  await attaching

  const drop = state.events.get(channels.dropFiles)!
  const paths = ['/synthetic/说明.md']
  drop(main.sender(), paths)
  expect(state.windows).toHaveLength(1)
  drop(ball.sender(), paths)
  const panel = state.windows[1]!
  expect(createDroppedReference).not.toHaveBeenCalled()

  state.events.get(channels.panelReady)!(panel.sender())
  await vi.waitFor(() => expect(panel.webContents.send).toHaveBeenCalledWith(
    channels.droppedReference, { ok: true, result: reference },
  ))
  expect(createDroppedReference).toHaveBeenCalledExactlyOnceWith(paths[0])
  const messages = panel.webContents.send.mock.calls.map(([channel]) => channel)
  expect(messages.indexOf(channels.openChat)).toBeLessThan(messages.indexOf(channels.droppedReference))
})

it('独立窗口未就绪时保留主界面入口，其他渲染器无法冒充悬浮球', async () => {
  vi.useFakeTimers()
  const main = new WindowStub()
  await main.loadURL(uiUrl)
  registerChatFabWindow({ uiUrl, preload: '合成预加载', panelPreload: '合成面板预加载', prewarm: false, enabled: () => true,
    mainWindow: () => main.asWindow() })
  const attaching = state.attach.get(channels.attach)!(main.sender())
  state.events.get(channels.gesture)!(main.sender(), 'ready')
  state.events.get(channels.gesture)!(main.sender(), 'open')
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(attaching).resolves.toBe(false)
  expect(state.windows).toHaveLength(1)
  expect(state.windows[0]?.destroyed).toBe(true)
})
