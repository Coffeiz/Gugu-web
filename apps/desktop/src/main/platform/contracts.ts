import type { App, BrowserWindow, BrowserWindowConstructorOptions, NativeImage, Rectangle } from 'electron'

export interface FloatingChatPlatform {
  windowOptions: BrowserWindowConstructorOptions
  configureWindow?(window: BrowserWindow): void
  preventActivation?(window: BrowserWindow): void
  setGlass?(window: BrowserWindow, enabled: boolean): boolean
  canFocus(detached: boolean): boolean
  watchFullscreen?(onChange: (bounds?: Rectangle) => void): () => void
}

export interface DesktopPlatform {
  supported: boolean
  mac: boolean
  windowMaterial: BrowserWindowConstructorOptions
  mainWindowOptions: BrowserWindowConstructorOptions
  microphone: { isGranted(): boolean; request(): Promise<boolean> }
  showApp?(app: App): void
  tray?: { icon(app: App, assets: string): NativeImage; openOnClick: boolean }
  createFloatingChat(preload: string): FloatingChatPlatform
}
