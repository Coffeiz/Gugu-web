import { app, nativeImage, nativeTheme } from 'electron'
import { join } from 'node:path'
import type { DesktopPlatform } from '../contracts.js'
import { watchWindowsFullscreen } from './fullscreen.js'

export const windowsPlatform: DesktopPlatform = {
  supported: true,
  mac: false,
  windowMaterial: { icon: join(app.getAppPath(), 'assets', nativeTheme.shouldUseDarkColors ? 'icon-win-dark.ico' : 'icon-win-light.ico'), backgroundMaterial: 'acrylic', transparent: false, backgroundColor: '#00000000' },
  mainWindowOptions: {
    titleBarStyle: 'hidden', frame: true, roundedCorners: true,
    icon: join(app.getAppPath(), 'assets', nativeTheme.shouldUseDarkColors ? 'icon-win-dark.ico' : 'icon-win-light.ico'),
    autoHideMenuBar: false,
  },
  microphone: { isGranted: () => true, request: async () => true },
  tray: { icon: (_app, assets) => windowsTrayIcon(assets), openOnClick: true },
  createFloatingChat: () => ({
    windowOptions: {},
    setGlass(window) {
      // DWM Acrylic 会填满透明分层窗口，拖动时出现 HWND 矩形底色。
      // 悬浮球保留逐像素透明画布，不能复用主窗口的整窗材质。
      window.setBackgroundMaterial('none')
      window.setBackgroundColor('#00000000')
      return false
    },
    canFocus: () => true,
    watchFullscreen: watchWindowsFullscreen,
  }),
}

export function windowsTrayIcon(assets: string) {
  const source = nativeImage.createFromPath(join(assets, 'trayTemplate.png')).resize({ width: 20, height: 20 })
  const bitmap = source.toBitmap()
  const color = nativeTheme.shouldUseDarkColors ? 255 : 0
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset] = color
    bitmap[offset + 1] = color
    bitmap[offset + 2] = color
  }
  return nativeImage.createFromBitmap(bitmap, source.getSize())
}