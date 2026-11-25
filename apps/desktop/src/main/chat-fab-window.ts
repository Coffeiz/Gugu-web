import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { BrowserWindow, ipcMain, screen, type Point, type Rectangle } from 'electron'
import { chatFabChannels as channels } from '../chat-fab-channels.js'
import { desktopReply } from './core-host.js'
import { watchWindowsFullscreen } from './foreground-fullscreen.js'
import { secureWindow, trustedCaller, windowOptions } from './windows.js'

const extent = 72
const inset = 17
const snapDuration = 220
const panelResizeDuration = 420
const floatingWidthRatio = 0.68
// 球和面板原生窗口的透明留边分别为 11px 和 4px。
const compactEdgeCorrection = 7
const compactGap = -5

export function registerChatFabWindow(options: {
  uiUrl: string
  preload: string
  panelPreload: string
  mainWindow: () => BrowserWindow | undefined
  enabled: () => boolean
  prewarm?: boolean
  createDroppedReference?: (path: string) => Promise<{ type: 'file'; id: string; label: string }>
}) {
  let preventNativeActivation: ((handle: Buffer) => boolean) | undefined
  let nativeGlass: ((handle: Buffer, enabled: boolean) => boolean) | undefined
  if (process.platform === 'darwin') {
    try {
      const native = createRequire(import.meta.url)(
        join(dirname(options.preload), '..', 'native', 'chat-fab-glass.node'),
      )
      nativeGlass = native.setChatFabGlass
      preventNativeActivation = native.preventChatFabActivation
    } catch {
      console.warn('无法加载聊天悬浮球毛玻璃')
    }
  }
  const address = new URL(options.uiUrl)
  address.searchParams.set('chatFab', '1')
  const panelAddress = new URL(options.uiUrl)
  panelAddress.searchParams.set('chatFabPanel', '1')
  let panel: BrowserWindow | undefined
  let panelResizeTimer: ReturnType<typeof setTimeout> | undefined
  let geometryId = 0
  let panelVisualBounds: Rectangle | undefined
  let panelHitTimer: ReturnType<typeof setInterval> | undefined
  let ignorePanelMouse = false
  let nativeResizeAnchor: Point | undefined
  let panelNativeChange: 'move' | 'resize' | undefined
  let panelDetached: boolean | undefined
  let panelOffset: Point = { x: 0, y: 0 }
  let jointMotion: { frame: Point; visual: Point } | undefined
  let finishPanelGeometry: (() => void) | undefined
  let warmTimer: ReturnType<typeof setTimeout> | undefined
  let droppedPaths: string[] = []
  let panelReady = false
  let expanded = false
  let floatingSize: { width: number; height: number } | undefined
  let panelRequested = false
  let panelOpenSent = false
  let panelEntered = false
  let panelFocusRequested = false
  let ball: BrowserWindow | undefined
  let loading: Promise<boolean> | undefined
  let resolveReady: ((ready: boolean) => void) | undefined
  let mode: 'docked' | 'detached' | 'dragging' | 'snapping' = 'docked'
  let gesture: { cursor: Point; origin: Point; previous: 'docked' | 'detached' } | undefined
  let snapTimer: ReturnType<typeof setInterval> | undefined
  let mainChatVisible = false
  let referenceDrag = false

  let stopFullscreenWatch: (() => void) | undefined
  let fullscreenArea: Rectangle | undefined

  function syncDetachedBall() {
    if (mode !== 'detached' || !ball) return
    const { x, y, width, height } = ball.getBounds()
    const area = fullscreenArea
    const covered = area && x < area.x + area.width && x + width > area.x
      && y < area.y + area.height && y + height > area.y
    if (covered) {
      if (ball.isVisible()) ball.hide()
      if (panel?.isVisible()) panel.hide()
    } else {
      if (!ball.isVisible()) ball.showInactive()
      syncPanelWindow()
    }
  }

  function stopWatchingFullscreen() {
    stopFullscreenWatch?.()
    stopFullscreenWatch = undefined
    fullscreenArea = undefined
  }

  function trustsPanel(event: Parameters<typeof trustedCaller>[0]) {
    return !!panel && trustedCaller(event, [panel], panelAddress.href)
  }

  function stopPanelResize() {
    clearTimeout(panelResizeTimer)
    panelResizeTimer = undefined
    finishPanelGeometry = undefined
  }

  function syncPanelHitArea() {
    if (!panel || panel.isDestroyed()) return
    const bounds = panelVisualBounds
    const cursor = screen.getCursorScreenPoint()
    const ignore = !!bounds && panelOpenSent && !(expanded && mode === 'detached') && !finishPanelGeometry && panel.isVisible()
      && (cursor.x < bounds.x + 4 || cursor.x >= bounds.x + bounds.width - 4
        || cursor.y < bounds.y + 4 || cursor.y >= bounds.y + bounds.height - 4)
    if (ignore === ignorePanelMouse) return
    ignorePanelMouse = ignore
    panel.setIgnoreMouseEvents(ignore)
  }

  function setPanelBounds(window: BrowserWindow, target: Rectangle, frame: Rectangle, resizable: boolean,
    minWidth: number, minHeight: number, animate: boolean) {
    stopPanelResize()
    const from = panelVisualBounds ?? target
    panelVisualBounds = target
    panelNativeChange = undefined
    const id = ++geometryId
    let reframe = false
    const finish = () => {
      stopPanelResize()
      if (resizable && (frame.x !== target.x || frame.y !== target.y ||
        frame.width !== target.width || frame.height !== target.height)) {
        // 动画视口可能大于可见面板；结束后让系统缩放边缘贴合面板。
        window.setBounds(target)
        frame = window.getBounds()
        panelOffset = { x: target.x - frame.x, y: target.y - frame.y }
        reframe = true
      }
      window.setMinimumSize(minWidth, minHeight)
      window.setResizable(resizable)
      window.webContents.send(channels.panelGeometry, { id, settled: true, target, frame, reframe })
      syncPanelHitArea()
    }
    const current = window.getBounds()
    if (current.x !== frame.x || current.y !== frame.y || current.width !== frame.width || current.height !== frame.height) {
      reframe = true
      window.setMinimumSize(1, 1)
      panelNativeChange = undefined
      window.setBounds(frame)
    }
    frame = window.getBounds()
    panelOffset = { x: target.x - frame.x, y: target.y - frame.y }
    if (!animate || !window.isVisible() || !panelEntered) {
      finish()
      return
    }
    window.setResizable(false)
    finishPanelGeometry = finish
    syncPanelHitArea()
    window.webContents.send(channels.panelGeometry, { id, from, target, frame, duration: panelResizeDuration })
    panelResizeTimer = setTimeout(finish, panelResizeDuration + 600)
  }

  function positionPanel(animate = false, preserveCompactFrame = false) {
    syncPanelDragRegion()
    if (!ball || !panel || panel.isDestroyed()) return
    const anchor = ball.getBounds()
    const area = screen.getDisplayNearestPoint({ x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 }).workArea
    const main = options.mainWindow()
    const docked = mode === 'docked' && main && !main.isDestroyed()
    const minWidth = Math.min(480, area.width)
    const minHeight = Math.min(360, area.height)
    const right = anchor.x + anchor.width - compactEdgeCorrection
    const bottom = anchor.y + anchor.height - compactEdgeCorrection
    const desired = floatingSize ?? { width: Math.round(area.height * floatingWidthRatio), height: Math.round(area.height * 0.78) }
    const wide = Math.min(area.width, Math.max(minWidth, Math.min(desired.width, right - area.x)))
    const tall = Math.min(area.height, Math.max(minHeight, Math.min(desired.height, bottom - area.y)))
    let large = {
      x: Math.max(area.x, Math.min(right - wide, area.x + area.width - wide)),
      y: Math.max(area.y, Math.min(bottom - tall, area.y + area.height - tall)),
      width: wide, height: tall,
    }
    if (docked) {
      const bounds = main.getContentBounds()
      const left = Math.max(232, Math.round(bounds.width * 0.4 - 12))
      large = { x: bounds.x + left, y: bounds.y + 12,
        width: Math.max(1, bounds.width - left - 12), height: Math.max(1, bounds.height - 24) }
    }

    const top = Math.max(area.y, Math.min(anchor.y, area.y + area.height - anchor.height))
    const above = top - compactGap - area.y
    const below = area.y + area.height - top - anchor.height - compactGap
    const placeAbove = above >= 300 || above >= below
    const height = Math.min(580, Math.max(1, placeAbove ? above : below))
    const compactY = placeAbove ? top - compactGap - height : top + anchor.height + compactGap
    const compact = {
      x: Math.max(area.x, Math.min(right - minWidth, area.x + area.width - minWidth)),
      y: Math.max(area.y, Math.min(compactY, area.y + area.height - height)),
      width: minWidth, height,
    }
    // 紧凑与展开共用同一个原生视口，避免系统在新坐标重绘上一帧。
    const previous = animate ? panelVisualBounds : undefined
    const x = Math.min(compact.x, large.x, previous?.x ?? Infinity)
    const y = Math.min(compact.y, large.y, previous?.y ?? Infinity)
    let frame = { x, y,
      width: Math.max(compact.x + compact.width, large.x + large.width, previous ? previous.x + previous.width : -Infinity) - x,
      height: Math.max(compact.y + compact.height, large.y + large.height, previous ? previous.y + previous.height : -Infinity) - y }
    const bounds = panel.getBounds()
    const contains = (outer: Rectangle, inner: Rectangle) =>
      inner.x >= outer.x && inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
    if (preserveCompactFrame && !expanded && panelVisualBounds && panel.isVisible() && contains(bounds, compact)) {
      const previous = panelVisualBounds
      // 交接期间保留原生视口，避免短暂用新边界裁切旧内容。
      setPanelBounds(panel, compact, bounds, false, 1, 1,
        previous.x !== compact.x || previous.y !== compact.y ||
        previous.width !== compact.width || previous.height !== compact.height)
      return
    }
    if (docked && !expanded && !animate) {
      // 在停靠的小窗中预留脱离后的展开空间，松手时无需再扩大视口。
      const maxHeight = Math.max(...screen.getAllDisplays().map(display => display.workArea.height))
      const reserve = floatingSize ?? { width: Math.round(maxHeight * floatingWidthRatio), height: Math.round(maxHeight * 0.78) }
      const left = Math.min(compact.x, right - Math.max(minWidth, reserve.width))
      const top = Math.min(compact.y, bottom - Math.max(minHeight, reserve.height))
      frame = {
        x: left, y: top,
        width: Math.max(compact.x + compact.width, right) - left,
        height: Math.max(compact.y + compact.height, bottom) - top,
      }
    }
    if (!docked && animate && contains(bounds, frame)) frame = bounds
    const resizable = expanded && !docked
    setPanelBounds(panel, expanded ? large : compact, frame, resizable,
      resizable ? minWidth : 1, resizable ? minHeight : 1, animate)
  }

  function showPanel() {
    if (!panel || !panelReady || !panelRequested || mainChatVisible) return
    syncPanelWindow()
    if (!panelOpenSent) {
      positionPanel()
      panelOpenSent = true
      panel.webContents.send(channels.openChat)
      syncPanelHitArea()
    }
    focusPanel()
    const paths = droppedPaths
    droppedPaths = []
    if (paths.length) void deliverDroppedPaths(panel, paths, () => panelRequested)
  }

  async function deliverDroppedPaths(target: BrowserWindow, paths: string[], isActive: () => boolean) {
    const createReference = options.createDroppedReference
    if (!createReference) return
    for (const path of paths) {
      const reply = await desktopReply(true, () => createReference(path))
      if (target.isDestroyed() || !isActive()) return
      target.webContents.send(channels.droppedReference, reply)
    }
  }

  function focusPanel() {
    if (!panel || !panelEntered || !panelFocusRequested || mode === 'dragging' || !panel.isVisible()) return
    panelFocusRequested = false
    // macOS 聚焦独立浮窗时也可能激活主窗，等用户直接操作浮窗再交给系统聚焦。
    if (mode !== 'detached' || process.platform !== 'darwin') panel.focus()
  }

  function syncPanelWindow() {
    if (!panel || !panelReady || !panelRequested || (mode === 'detached' && ball && !ball.isVisible())) return
    const main = options.mainWindow()
    const parent = mode === 'docked' && main && !main.isDestroyed() ? main : null
    if (parent) panel.setAlwaysOnTop(false)
    if (panel.getParentWindow() !== parent) {
      const position = panel.getBounds()
      panel.setParentWindow(parent)
      const current = panel.getBounds()
      if (current.x !== position.x || current.y !== position.y) panel.setPosition(position.x, position.y)
    }
    if (parent) {
      if (parent.isMinimized() || !parent.isVisible()) {
        panel.hide()
        return
      }
    } else {
      panel.setAlwaysOnTop(true, 'floating', 1)
    }
    if (!panel.isVisible()) panel.showInactive()
    syncPanelHitArea()
  }

  function openPanel() {
    clearTimeout(warmTimer)
    panelRequested = true
    panelFocusRequested = mode !== 'dragging'
    if (panel) showPanel()
    else createPanel()
  }

  function syncPanelDragRegion() {
    const detached = mode === 'detached'
    if (!panel || !panelReady || detached === panelDetached) return
    panelDetached = detached
    panel.webContents.send(channels.panelDetached, detached)
  }

  function createPanel() {
    const window = new BrowserWindow({
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      width: 480, height: 580, frame: false, transparent: true, backgroundColor: '#00000000',
      hasShadow: false, resizable: false, show: false, skipTaskbar: true, fullscreenable: false,
      webPreferences: windowOptions(options.panelPreload).webPreferences,
      title: '咕咕聊天',
    })
    panel = window
    secureWindow(window)
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false, skipTransformProcessType: true })
      if (preventNativeActivation) preventNativeActivation(window.getNativeWindowHandle())
    }
    window.on('show', () => {
      clearInterval(panelHitTimer)
      panelHitTimer = setInterval(syncPanelHitArea, 16)
    })
    window.on('hide', () => clearInterval(panelHitTimer))
    window.on('will-move', () => {
      if (mode === 'detached' && !finishPanelGeometry && panelNativeChange !== 'resize') panelNativeChange = 'move'
    })
    window.on('will-resize', (event, bounds) => {
      if (!expanded || mode !== 'detached' || finishPanelGeometry) return
      const current = window.getBounds()
      if (bounds.width === current.width && bounds.height === current.height) {
        event.preventDefault()
        return
      }
      if (panelNativeChange !== 'resize' && ball && panelVisualBounds) {
        const anchor = ball.getBounds()
        const visual = panelVisualBounds
        nativeResizeAnchor = { x: anchor.x - visual.x - visual.width, y: anchor.y - visual.y - visual.height }
        window.webContents.send(channels.panelGeometry, { id: ++geometryId, settled: true, target: current, frame: current })
      }
      panelNativeChange = 'resize'
    })
    const followNativePanel = () => {
      if (!ball || !panelVisualBounds || !panelNativeChange || mode !== 'detached') return
      const current = window.getBounds()
      const previous = panelVisualBounds
      const resizing = panelNativeChange === 'resize'
      if (resizing && current.width === previous.width && current.height === previous.height) return
      const target = resizing ? current : {
        ...previous,
        x: current.x + panelOffset.x, y: current.y + panelOffset.y,
      }
      const bx = target.x + target.width - previous.x - previous.width
      const by = target.y + target.height - previous.y - previous.height
      panelVisualBounds = target
      if (resizing) {
        floatingSize = { width: target.width, height: target.height }
        panelOffset = { x: 0, y: 0 }
      }
      const anchor = ball.getBounds()
      if (resizing && nativeResizeAnchor) {
        const x = target.x + target.width + nativeResizeAnchor.x
        const y = target.y + target.height + nativeResizeAnchor.y
        if (x !== anchor.x || y !== anchor.y) ball.setPosition(x, y)
      } else {
        ball.setPosition(anchor.x + bx, anchor.y + by)
      }
    }
    window.on('move', followNativePanel)
    window.on('resize', followNativePanel)
    window.on('moved', () => { if (panelNativeChange === 'move') panelNativeChange = undefined })
    window.on('resized', () => {
      panelNativeChange = undefined
      nativeResizeAnchor = undefined
    })
    window.once('closed', () => {
      stopPanelResize()
      clearInterval(panelHitTimer)
      ignorePanelMouse = false
      panelVisualBounds = undefined
      panelDetached = undefined
      panelNativeChange = undefined
      panel = undefined
      droppedPaths = []
      expanded = false
      panelReady = false
      panelRequested = false
      panelOpenSent = false
      panelEntered = false
      panelFocusRequested = false
    })
    window.webContents.once('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
    positionPanel()
    void window.loadURL(panelAddress.href).catch(() => { if (!window.isDestroyed()) window.destroy() })
  }

  ipcMain.on(channels.panelGeometryDone, (event, id: unknown) => {
    if (trustsPanel(event) && id === geometryId) finishPanelGeometry?.()
  })
  ipcMain.on(channels.panelExpanded, (event, value: unknown) => {
    if (!trustsPanel(event) || typeof value !== 'boolean' || expanded === value) return
    expanded = value
    positionPanel(true)
  })
  ipcMain.on(channels.panelReady, event => {
    if (!trustsPanel(event)) return
    panelReady = true
    showPanel()
  })
  ipcMain.on(channels.panelEntered, event => {
    if (!trustsPanel(event) || !panelRequested) return
    panelEntered = true
    focusPanel()
  })
  ipcMain.on(channels.panelClosing, event => {
    if (!trustsPanel(event)) return
    panelOpenSent = false
    panelEntered = false
    panelFocusRequested = false
    syncPanelHitArea()
  })
  ipcMain.on(channels.panelClose, event => {
    if (!trustsPanel(event) || panelOpenSent) return
    panelRequested = false
    panelOpenSent = false
    panelEntered = false
    panelFocusRequested = false
    panel?.hide()
  })

  function dockPoint(main: BrowserWindow): Point {
    const { x, y, width, height } = main.getContentBounds()
    return { x: x + width - extent - inset, y: y + height - extent - inset }
  }

  function setGlass(enabled: boolean) {
    if (!ball || !nativeGlass) return
    const applied = nativeGlass(ball.getNativeWindowHandle(), enabled)
    ball.webContents.send(channels.material, enabled && applied)
  }

  function moveBallAndPanel(x: number, y: number) {
    if (!ball) return
    if (!jointMotion && panel?.isVisible() && panelVisualBounds) {
      const origin = ball.getBounds()
      const frame = panel.getBounds()
      jointMotion = {
        frame: { x: frame.x - origin.x, y: frame.y - origin.y },
        visual: { x: frame.x + panelOffset.x - origin.x, y: frame.y + panelOffset.y - origin.y },
      }
    }
    ball.setPosition(x, y)
    if (!panel?.isVisible() || !panelVisualBounds || !jointMotion) return
    const anchor = ball.getBounds()
    const desiredX = anchor.x + jointMotion.frame.x
    const desiredY = anchor.y + jointMotion.frame.y
    const previousFrame = panel.getBounds()
    if (previousFrame.x !== desiredX || previousFrame.y !== desiredY) {
      panelNativeChange = undefined
      panel.setPosition(desiredX, desiredY)
    }
    const frame = panel.getBounds()
    const target = {
      ...panelVisualBounds,
      x: anchor.x + jointMotion.visual.x,
      y: anchor.y + jointMotion.visual.y,
    }
    panelVisualBounds = target
    const offset = { x: target.x - frame.x, y: target.y - frame.y }
    // macOS 可能限制原生窗的实际坐标。用实测边界推导内容偏移，避免逐帧累计误差。
    if (offset.x !== panelOffset.x || offset.y !== panelOffset.y) {
      panelOffset = offset
      panel.webContents.send(channels.panelGeometry, { id: ++geometryId, settled: true, target, frame })
    }
  }

  function dock() {
    const main = options.mainWindow()
    if (!ball || !main || main.isDestroyed()) return
    const docking = mode !== 'docked'
    if (docking) stopWatchingFullscreen()
    if (docking) setGlass(false)
    ball.setAlwaysOnTop(false)
    if (ball.getParentWindow() !== main) ball.setParentWindow(main)
    const { x, y } = dockPoint(main)
    if (docking) moveBallAndPanel(x, y)
    else ball.setPosition(x, y)
    jointMotion = undefined
    mode = 'docked'
    if (main.isVisible() && !main.isMinimized() && !referenceDrag) ball.showInactive()
    else ball.hide()
    syncPanelWindow()
    positionPanel(docking, docking)
  }

  function stopSnap() {
    clearInterval(snapTimer)
    snapTimer = undefined
  }

  function watchMain(main: BrowserWindow) {
    const sync = () => { if (mode === 'docked' && !loading) dock() }
    main.on('move', sync)
    main.on('resize', sync)
    main.on('show', sync)
    main.on('hide', sync)
    main.on('minimize', sync)
    main.on('restore', sync)
    main.on('enter-full-screen', sync)
    main.on('leave-full-screen', sync)
    main.once('closed', () => {
      referenceDrag = false
      mainChatVisible = false
      if (mode === 'snapping') {
        stopSnap()
        mode = 'detached'
      }
    })
  }

  async function create(main: BrowserWindow) {
    const window = new BrowserWindow({
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      width: extent, height: extent, frame: false, transparent: true, backgroundColor: '#00000000',
      hasShadow: false, resizable: false, show: false, skipTaskbar: true, focusable: false,
      fullscreenable: false, parent: main, title: '咕咕聊天',
      webPreferences: windowOptions(options.preload).webPreferences,
    })
    ball = window
    secureWindow(window)
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false, skipTransformProcessType: true })
      if (preventNativeActivation) preventNativeActivation(window.getNativeWindowHandle())
    }
    window.webContents.once('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
    window.once('closed', () => {
      resolveReady?.(false)
      stopSnap()
      clearTimeout(warmTimer)
      stopWatchingFullscreen()
      ball = undefined
      gesture = undefined
      jointMotion = undefined
      if (panel && !panel.isDestroyed()) panel.destroy()
      mode = 'docked'
    })
    const ready = new Promise<boolean>(resolve => { resolveReady = resolve })
    const timeout = setTimeout(() => resolveReady?.(false), 10_000)
    try {
      void window.loadURL(address.href).catch(() => resolveReady?.(false))
      if (!await ready || window.isDestroyed()) {
        if (!window.isDestroyed()) window.destroy()
        return false
      }
      dock()
      if (options.prewarm !== false) {
        warmTimer = setTimeout(() => {
          if (ball && !panel && options.enabled()) createPanel()
        }, 500)
      }
      return true
    } finally {
      clearTimeout(timeout)
      resolveReady = undefined
    }
  }

  ipcMain.handle(channels.attach, async event => {
    const main = options.mainWindow()
    if (!options.enabled() || !main || !trustedCaller(event, [main], options.uiUrl)) return false
    if (loading) return loading
    if (ball) return true
    loading = create(main).finally(() => { loading = undefined })
    return loading
  })

  function snap(main: BrowserWindow) {
    if (!ball) return
    const { x, y } = ball.getBounds()
    const start = Date.now()
    mode = 'snapping'
    snapTimer = setInterval(() => {
      if (!ball || main.isDestroyed()) {
        stopSnap()
        jointMotion = undefined
        mode = 'detached'
        return
      }
      if (main.isMinimized() || !main.isVisible()) {
        stopSnap()
        dock()
        return
      }
      const progress = Math.min(1, (Date.now() - start) / snapDuration)
      const eased = 1 - (1 - progress) ** 3
      const target = dockPoint(main)
      moveBallAndPanel(Math.round(x + (target.x - x) * eased), Math.round(y + (target.y - y) * eased))
      if (progress === 1) {
        stopSnap()
        dock()
      }
    }, 16)
  }

  function move(cursor: Point) {
    if (!gesture || !ball) return
    const dx = cursor.x - gesture.cursor.x
    const dy = cursor.y - gesture.cursor.y
    if (mode !== 'dragging') {
      if (Math.hypot(dx, dy) < 5) return
      finishPanelGeometry?.()
      mode = 'dragging'
      setGlass(true)
    }
    moveBallAndPanel(Math.round(gesture.origin.x + dx), Math.round(gesture.origin.y + dy))
  }

  function release(cursor: Point, cancelled: boolean) {
    if (!ball || !gesture) return
    if (!cancelled) move(cursor)
    const { previous, origin } = gesture
    gesture = undefined
    if (mode !== 'dragging') {
      if (!cancelled) toggleChat()
      return
    }
    const main = options.mainWindow()
    const { x, y } = ball.getBounds()
    const destination = cancelled ? origin : { x, y }
    const center = { x: destination.x + extent / 2, y: destination.y + extent / 2 }
    const bounds = main?.getContentBounds()
    const inside = main && main.isVisible() && !main.isMinimized() && bounds
      && center.x >= bounds.x && center.x < bounds.x + bounds.width
      && center.y >= bounds.y && center.y < bounds.y + bounds.height
    // 改父窗口会中断部分平台的指针捕获，等松手处理完落点再做。
    if (ball.getParentWindow()) ball.setParentWindow(null)
    if (preventNativeActivation) preventNativeActivation(ball.getNativeWindowHandle())
    ball.setAlwaysOnTop(true, 'floating')
    if (main && (cancelled ? previous === 'docked' : inside)) snap(main)
    else {
      const { workArea } = screen.getDisplayNearestPoint(center)
      moveBallAndPanel(
        Math.max(workArea.x, Math.min(destination.x, workArea.x + workArea.width - extent)),
        Math.max(workArea.y, Math.min(destination.y, workArea.y + workArea.height - extent)),
      )
      jointMotion = undefined
      mode = 'detached'
      if (process.platform === 'win32' && !stopFullscreenWatch) {
        stopFullscreenWatch = watchWindowsFullscreen(bounds => {
          if (!stopFullscreenWatch) return
          fullscreenArea = bounds ? screen.screenToDipRect(null, bounds) : undefined
          syncDetachedBall()
        })
      }
      syncPanelWindow()
      // 脱离时就预留展开视口，避免第一次展开同时改变原生视口和内容布局。
      positionPanel(expanded && previous === 'docked', true)
      if (previous === 'docked' && mainChatVisible && main && !main.isDestroyed()) {
        main.webContents.send(channels.closeChat)
        openPanel()
      }
    }
  }

  function toggleChat() {
    const main = options.mainWindow()
    if (mainChatVisible && main && !main.isDestroyed()) {
      main.webContents.send(channels.closeChat, true)
      return
    }
    if (panelOpenSent || (!panelReady && panelRequested)) {
      if (!panelRequested) return
      panelRequested = false
      droppedPaths = []
      panelFocusRequested = false
      if (panelOpenSent) panel?.webContents.send(channels.closeChat, true)
      return
    }
    openPanel()
  }

  ipcMain.on(channels.chatVisible, (event, visible: unknown) => {
    const main = options.mainWindow()
    if (!main || !trustedCaller(event, [main], options.uiUrl) || typeof visible !== 'boolean') return
    mainChatVisible = visible
    if (!visible) showPanel()
    else if (panelOpenSent) {
      panelRequested = false
      panel?.hide()
      panel?.webContents.send(channels.closeChat)
    }
  })

  ipcMain.on(channels.referenceDrag, (event, active: unknown) => {
    const main = options.mainWindow()
    if (!main || !trustedCaller(event, [main], options.uiUrl) || typeof active !== 'boolean') return
    referenceDrag = active
    if (ball && mode === 'docked' && !loading) dock()
  })

  ipcMain.on(channels.dropFiles, (event, paths: unknown) => {
    if (!options.enabled() || !ball || !options.createDroppedReference || !trustedCaller(event, [ball], address.href)
      || !Array.isArray(paths) || !paths.length || paths.length > 50
      || !paths.every(path => typeof path === 'string' && path.length > 0 && path.length <= 4096)) return
    const main = options.mainWindow()
    if (mode === 'docked' && mainChatVisible && main && !main.isDestroyed()) {
      void deliverDroppedPaths(main, paths, () => mainChatVisible)
      return
    }
    droppedPaths = [...droppedPaths, ...paths].slice(0, 50)
    openPanel()
  })

  ipcMain.on(channels.gesture, (event, action: unknown, x: unknown, y: unknown) => {
    if (!options.enabled() || !ball || !trustedCaller(event, [ball], address.href)) return
    if (action === 'ready') {
      resolveReady?.(true)
      return
    }
    if (loading) return
    if (action === 'open') { toggleChat(); return }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
    const cursor = { x, y }
    if (action === 'down' && !gesture) {
      const previous = mode === 'docked' ? 'docked' : 'detached'
      if (mode === 'snapping') {
        stopSnap()
        mode = 'detached'
      }
      const { x, y } = ball.getBounds()
      gesture = { cursor, origin: { x, y }, previous }
    }
    if (action === 'move') move(cursor)
    if (action === 'up' || action === 'cancel') release(cursor, action === 'cancel')
  })

  return {
    watchMain,
    hasVisibleDetachedWindow: () => mode === 'detached' && Boolean(ball?.isVisible() || panel?.isVisible()),
    trustsPanel,
    sendToPanel: (channel: string, ...args: unknown[]) => {
      if (panel && !panel.isDestroyed()) panel.webContents.send(channel, ...args)
    },
  }
}
