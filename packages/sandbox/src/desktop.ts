import { macosShell } from './macos/shell.js'
import { windowsShell } from './windows/shell.js'

export function desktopShellPlatform(platform = process.platform) {
  if (platform === 'darwin') return macosShell
  if (platform === 'win32') return windowsShell
  return undefined
}
