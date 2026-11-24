import { app, BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { DesktopError } from './core-host.js'

export function createNativeFileDialogs(mainWindow: () => BrowserWindow | undefined) {
  let active = false

  async function show<Result>(openPanel: (parent?: BrowserWindow) => Promise<Result>): Promise<Result> {
    if (active) throw new DesktopError('conflict', '系统文件选择窗口已打开')
    active = true
    try {
      // macOS 使用独立系统面板，避免面板挂在被遮挡或已最小化的窗口上。
      if (process.platform === 'darwin') {
        app.focus({ steal: true })
        return await openPanel()
      }
      const parent = BrowserWindow.getFocusedWindow() ?? mainWindow()
      return await openPanel(parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized() ? parent : undefined)
    } finally {
      active = false
    }
  }

  return {
    open(options: OpenDialogOptions) {
      return show(parent => parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
    },
    save(options: SaveDialogOptions) {
      return show(parent => parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options))
    },
  }
}
