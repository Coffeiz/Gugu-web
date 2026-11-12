import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  Menu,
  dialog,
  protocol,
  net,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  CoreHost,
  desktopHandlers,
  desktopReply,
  verifyArtifact,
  DesktopError,
} from './core-host.js'
import { DesktopLifecycle } from './lifecycle.js'
import {
  secureWindow,
  trustedCaller,
  windowOptions,
  uiResourcePath,
  DESKTOP_UI_URL,
} from './windows.js'
import { DesktopUpdater } from './updater.js'
import { sandboxDiagnostics } from '../sandbox/diagnostics.js'

app.setName('咕咕桌面验证')
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gugu-desktop',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])
const smoke = process.argv.includes('--smoke')
let dataDirectory = join(app.getPath('appData'), 'com.gugu.desktop.preview')
if (smoke) {
  const provided = process.env.GUGU_DESKTOP_TEST_DIRECTORY
  if (!provided) throw new Error('冒烟必须显式提供临时目录')
  const target = realpathSync(provided),
    temporary = realpathSync(tmpdir())
  if (
    !target.startsWith(temporary + sep) ||
    readFileSync(join(target, '.gugu-smoke'), 'utf8') !== 'gugu-desktop-smoke-v1'
  )
    throw new Error('冒烟目录未经隔离验证')
  dataDirectory = target
}
mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', dataDirectory)
if (!app.requestSingleInstanceLock()) app.quit()
else {
  let lifecycle: DesktopLifecycle | undefined,
    quitting = false
  app.on('before-quit', (event) => {
    if (quitting || !lifecycle) return
    event.preventDefault()
    void lifecycle.close().finally(() => {
      quitting = true
      app.quit()
    })
  })
  app.on('window-all-closed', () => app.quit())
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })
  void app
    .whenReady()
    .then(async () => {
      if (!smoke && !['win32', 'darwin'].includes(process.platform))
        throw new DesktopError(
          'unsupported',
          '桌面验证版仅面向 macOS 与 Windows；Linux 请使用多用户服务端',
        )
      const resource = app.isPackaged
        ? process.resourcesPath
        : join(app.getAppPath(), 'resources')
      const artifact = await verifyArtifact(join(resource, 'core-sidecar'))
      mkdirSync(dataDirectory, { recursive: true })
      lifecycle = new DesktopLifecycle(() =>
        CoreHost.launch(
          artifact.node,
          artifact.entry,
          join(dataDirectory, 'core.db'),
          artifact.manifest,
        ),
      )
      await lifecycle.start()
      const host = lifecycle
      const uiPath = app.isPackaged
        ? join(app.getAppPath(), 'ui/desktop.html')
        : resolve(app.getAppPath(), '../frontend/dist-desktop/desktop.html')
      const uiUrl = DESKTOP_UI_URL
      protocol.handle('gugu-desktop', async (request) => {
        if (request.method !== 'GET') return new Response('界面资源不可用', { status: 405 })
        try {
          return await net.fetch(
            pathToFileURL(await uiResourcePath(request.url, resolve(uiPath, '..'))).href,
          )
        } catch {
          return new Response('界面资源不可用', { status: 404 })
        }
      })
      const createWindow = async () => {
        const window = new BrowserWindow(
          windowOptions(join(app.getAppPath(), 'dist/preload/index.cjs'), smoke),
        )
        secureWindow(window)
        await window.loadURL(uiUrl)
        return window
      }
      for (const [channel, action] of Object.entries(
        desktopHandlers(host, () => sandboxDiagnostics(host)),
      ))
        ipcMain.handle(channel, (event, ...args: unknown[]) =>
          desktopReply(trustedCaller(event, BrowserWindow.getAllWindows(), uiUrl), () =>
            action(...args),
          ),
        )
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.allowDowngrade = false
      autoUpdater.logger = null
      const updater = new DesktopUpdater(
        app.isPackaged && existsSync(join(resource, 'app-update.yml'))
          ? {
              check: async () => {
                const result = await autoUpdater.checkForUpdates()
                return result?.isUpdateAvailable ? result.updateInfo.version : null
              },
              download: async () => {
                await autoUpdater.downloadUpdate()
              },
              install: () => autoUpdater.quitAndInstall(false, true),
            }
          : null,
        () => host.close(),
      )
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: '咕咕',
            submenu: [
              {
                label: '检查更新',
                enabled: updater.status().state !== 'disabled',
                click: async () => {
                  try {
                    if (updater.status().state !== 'downloaded') {
                      await updater.check()
                      if (updater.status().state !== 'available') {
                        await dialog.showMessageBox({
                          message: '当前没有可用更新',
                        })
                        return
                      }
                      const download = await dialog.showMessageBox({
                        message: '发现新版本，是否下载更新？',
                        buttons: ['取消', '下载'],
                        defaultId: 0,
                        cancelId: 0,
                      })
                      if (download.response !== 1) return
                      await updater.download()
                    }
                    const install = await dialog.showMessageBox({
                      message: '更新已下载并校验。安装将关闭本地工作台，是否继续？',
                      buttons: ['稍后', '安装并重启'],
                      defaultId: 0,
                      cancelId: 0,
                    })
                    if (install.response === 1) await updater.install(true)
                  } catch {
                    await dialog.showMessageBox({
                      type: 'error',
                      message: '更新未完成，请重新启动当前版本后检查更新状态',
                    })
                  }
                },
              },
              { type: 'separator' },
              { role: 'quit', label: '退出' },
            ],
          },
          {
            label: '编辑',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
        ]),
      )
      powerMonitor.on('suspend', () => {
        void host.pause().catch(() => undefined)
      })
      powerMonitor.on('resume', () => {
        void host.start().catch(() => undefined)
      })
      app.on('activate', () => {
        if (!quitting && !BrowserWindow.getAllWindows().length) void createWindow()
      })
      await createWindow()
    })
    .catch(async (error) => {
      await lifecycle?.close()
      if (!smoke)
        await dialog.showMessageBox({
          type: 'error',
          message:
            error instanceof DesktopError
              ? error.message
              : '桌面启动失败，请检查匹配的运行时制品与数据状态',
        })
      process.exitCode = 1
      quitting = true
      app.exit(1)
    })
}
