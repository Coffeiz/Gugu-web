import { win32 } from 'node:path'
import { createMxcExecutor, mxcDiagnostics } from '../mxc/platform.js'

export const windowsShell = {
  id: 'mxc-processcontainer-offline-v1',
  method: 'processcontainer',
  diagnostics: mxcDiagnostics,
  createExecutor: createMxcExecutor,
  command(command: string) {
    const shell = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    return `"${shell}" /d /s /c "${command}"`
  },
}
