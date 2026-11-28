import { nativeImage, systemPreferences } from 'electron'
import { join } from 'node:path'
import type { DesktopPlatform } from '../contracts.js'
import { createMacFloatingChat } from './floating-chat.js'

export const macosPlatform: DesktopPlatform = {
  supported: true,
  mac: true,
  windowMaterial: { vibrancy: 'under-window', visualEffectState: 'followWindow', transparent: true, backgroundColor: '#00000000' },
  mainWindowOptions: { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 16 } },
  microphone: {
    isGranted: () => systemPreferences.getMediaAccessStatus('microphone') === 'granted',
    request: () => systemPreferences.askForMediaAccess('microphone'),
  },
  showApp: app => app.show(),
  tray: {
    icon(app, assets) {
      const icon = nativeImage.createFromPath(join(assets, 'trayTemplate.png'))
      icon.setTemplateImage(true)
      if (!app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(join(assets, 'icon-macos.png')))
      return icon
    },
    openOnClick: false,
  },
  createFloatingChat: createMacFloatingChat,
}
