import { nativeImage } from 'electron'
import { join } from 'node:path'
import type { DesktopPlatform } from '../contracts.js'
import { watchWindowsFullscreen } from './fullscreen.js'

export const windowsPlatform: DesktopPlatform = {
  supported: true,
  mac: false,
  windowMaterial: { backgroundMaterial: 'acrylic', transparent: true, backgroundColor: '#00000000' },
  mainWindowOptions: {
    titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 16 },
    frame: false, titleBarOverlay: { color: '#00000000', symbolColor: '#343741', height: 64 },
  },
  microphone: { isGranted: () => true, request: async () => true },
  tray: { icon: (_app, assets) => nativeImage.createFromPath(join(assets, 'icon.png')).resize({ width: 16 }), openOnClick: true },
  createFloatingChat: () => ({ windowOptions: {}, canFocus: () => true, watchFullscreen: watchWindowsFullscreen }),
}
