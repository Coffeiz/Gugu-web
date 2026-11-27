import type { DesktopPlatform } from './contracts.js'
import { macosPlatform } from './macos/index.js'
import { windowsPlatform } from './windows/index.js'

// 非发布平台仅用于开发验证。
const developmentPlatform: DesktopPlatform = {
  supported: false,
  mac: false,
  windowMaterial: {},
  mainWindowOptions: { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 16 } },
  microphone: { isGranted: () => true, request: async () => true },
  createFloatingChat: () => ({ windowOptions: {}, canFocus: () => true }),
}

export function desktopPlatform(): DesktopPlatform {
  if (process.platform === 'darwin') return macosPlatform
  if (process.platform === 'win32') return windowsPlatform
  return developmentPlatform
}
