import type {
  BrowserWindowConstructorOptions,
  BrowserWindow,
  IpcMainInvokeEvent,
} from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

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

export function windowOptions(
  preload: string,
  hidden = false,
): BrowserWindowConstructorOptions {
  return {
    title: '咕咕 · 本地工作台',
    width: 1024,
    height: 740,
    minWidth: 680,
    minHeight: 480,
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
export function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
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
