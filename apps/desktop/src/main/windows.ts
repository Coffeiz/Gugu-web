import { applicationMenuChannels, type ApplicationEditAction } from '@gugu/desktop-contracts'
import { nativeEditingChannel, type EditingFocus } from '../keyboard-editing.js'
import type {
  BrowserWindowConstructorOptions,
  BrowserWindow,
  IpcMainInvokeEvent,
  Rectangle,
  Size,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export function createMainWindowSizeStore(directory: string) {
  const path = join(directory, 'main-window-size.json')
  return {
    read(): Size | undefined {
      try {
        const { width, height } = JSON.parse(readFileSync(path, 'utf8'))
        if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0)
          return { width, height }
      } catch {
        // 尺寸文件缺失或损坏时使用默认尺寸。
      }
    },
    save({ width, height }: Size): void {
      writeWindowGeometry(path, { width, height })
    },
  }
}

function writeWindowGeometry(path: string, geometry: Size | Rectangle) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(geometry), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function createProjectWindowBoundsStore(directory: string) {
  const path = join(directory, 'project-window-bounds.json')
  return {
    read(): Rectangle | undefined {
      try {
        const { x, y, width, height } = JSON.parse(readFileSync(path, 'utf8'))
        if ([x, y, width, height].every(Number.isSafeInteger) && width > 0 && height > 0)
          return { x, y, width, height }
      } catch {
        // 首次打开或记录损坏时沿用默认布局。
      }
    },
    save({ x, y, width, height }: Rectangle): void {
      writeWindowGeometry(path, { x, y, width, height })
    },
  }
}

export function fitProjectWindowBounds(bounds: Rectangle, area: Rectangle, minimum: Size): Rectangle {
  const width = Math.max(minimum.width, Math.min(bounds.width, area.width))
  const height = Math.max(minimum.height, Math.min(bounds.height, area.height))
  return {
    x: Math.min(Math.max(area.x, bounds.x), area.x + Math.max(0, area.width - width)),
    y: Math.min(Math.max(area.y, bounds.y), area.y + Math.max(0, area.height - height)),
    width, height,
  }
}

export const DESKTOP_UI_URL = 'gugu-desktop://app/desktop.html'
export async function uiResourcePath(address: string, directory: string): Promise<string> {
  const url = new URL(address)
  if (
    url.protocol !== 'gugu-desktop:' ||
    url.hostname !== 'app' ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('界面资源来源无效')
  const root = await realpath(directory),
    requested = decodeURIComponent(url.pathname)
  if (requested.includes('\0') || requested.includes('\\'))
    throw new Error('界面资源路径无效')
  const file = await realpath(resolve(root, `.${requested}`))
  if (!file.startsWith(root + sep) || !(await stat(file)).isFile())
    throw new Error('界面资源越界')
  return file
}

export function desktopWindowMaterial(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin')
    return { vibrancy: 'under-window', visualEffectState: 'followWindow', transparent: true, backgroundColor: '#00000000' }
  if (process.platform === 'win32')
    return { backgroundMaterial: 'acrylic', transparent: true, backgroundColor: '#00000000' }
  return {}
}

export function windowOptions(
  preload: string,
  hidden = false,
  restored?: { size: Size; workArea: Size },
): BrowserWindowConstructorOptions {
  const minWidth = 960, minHeight = 600
  return {
    title: '咕咕 · 本地工作台',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    ...desktopWindowMaterial(),
    ...(process.platform === 'win32'
      ? { frame: false, titleBarOverlay: { color: '#00000000', symbolColor: '#343741', height: 64 } }
      : {}),
    width: restored ? Math.max(minWidth, Math.min(restored.size.width, restored.workArea.width)) : 1440,
    height: restored ? Math.max(minHeight, Math.min(restored.size.height, restored.workArea.height)) : 800,
    minWidth,
    minHeight,
    show: !hidden,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  }
}
const editingFocus = new WeakMap<Electron.WebContents, EditingFocus>()
const rendererEditKeys = new Set(['a', 'c', 'v', 'x', 'y', 'z'])

export function dispatchWindowEdit(contents: Electron.WebContents, action: ApplicationEditAction) {
  if (contents.isDestroyed()) return
  const focus = editingFocus.get(contents) ?? 'page'
  const editorHistory = focus === 'editor' && (action === 'undo' || action === 'redo')
  if (focus === 'page' || editorHistory) contents.send(applicationMenuChannels.edit, action)
  else contents[action]()
}

export function secureWindow(window: BrowserWindow, openExternal?: (url: string) => void) {
  window.webContents.ipc.on(nativeEditingChannel, (event, focus: unknown) => {
    if (event.senderFrame !== window.webContents.mainFrame) return
    if (focus === 'page' || focus === 'native' || focus === 'editor') editingFocus.set(window.webContents, focus)
  })
  window.webContents.on('before-input-event', (_event, input) => {
    // 业务操作和富文本历史交给渲染器，原生输入框及文本剪贴板由系统处理。
    const mac = process.platform === 'darwin'
    const primary = mac ? input.meta : input.control
    const key = input.key.toLowerCase()
    const focus = editingFocus.get(window.webContents) ?? 'page'
    const renderer = focus === 'page' || (mac && focus === 'editor' && (key === 'z' || key === 'y'))
    window.webContents.setIgnoreMenuShortcuts(renderer && primary && !input.alt && rendererEditKeys.has(key))
  })
  window.webContents.setWindowOpenHandler(({ url, postBody }) => {
    if (openExternal && !postBody) {
      const target = URL.parse(url)
      if (target && ['https:', 'http:'].includes(target.protocol) && !target.username && !target.password)
        openExternal(target.href)
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.on('will-download', (event) => event.preventDefault())
}
export function trustedCaller(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  windows: readonly BrowserWindow[],
  uiUrl: string,
): boolean {
  return windows.some(
    (window) =>
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === uiUrl,
  )
}
