import { autoUpdater } from 'electron-updater'
import type { UpdateBackend } from './index.js'

export function createElectronUpdateBackend(useSystemProxy: () => boolean): UpdateBackend {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = null
  const configureProxy = () => autoUpdater.netSession.setProxy({ mode: useSystemProxy() ? 'system' : 'direct' })
  return {
    async check() {
      await configureProxy()
      const result = await autoUpdater.checkForUpdates()
      return result?.isUpdateAvailable ? result.updateInfo.version : null
    },
    async download(onProgress) {
      await configureProxy()
      const progress = ({ percent }: { percent: number }) => onProgress?.(percent)
      autoUpdater.on('download-progress', progress)
      try {
        await autoUpdater.downloadUpdate()
      } finally {
        autoUpdater.removeListener('download-progress', progress)
      }
    },
    install: () => autoUpdater.quitAndInstall(false, true),
  }
}
