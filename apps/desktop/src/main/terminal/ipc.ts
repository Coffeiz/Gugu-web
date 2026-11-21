import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers, IpcHost } from '../ipc/types.js'

export function desktopTerminalHandlers(host: IpcHost, personalRoot: () => Promise<string>): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.terminal]: async command => {
      if (!command || typeof command !== 'object' || !('action' in command))
        throw new DesktopError('invalid_request', '终端操作无效')
      const terminalId = 'terminalId' in command ? command.terminalId : undefined
      if (typeof terminalId !== 'string' || !/^[a-f0-9-]{36}$/.test(terminalId))
        throw new DesktopError('invalid_request', '终端标识无效')
      const action = command.action
      switch (action) {
        case 'open':
        case 'resize': {
          const cols = 'cols' in command ? command.cols : undefined
          const rows = 'rows' in command ? command.rows : undefined
          if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 20 || cols > 500
            || typeof rows !== 'number' || !Number.isInteger(rows) || rows < 5 || rows > 200)
            throw new DesktopError('invalid_request', '终端尺寸无效')
          return host.request('desktop.terminal', { action, terminalId, cols, rows, ...(action === 'open' ? { root: await personalRoot() } : {}) })
        }
        case 'input': {
          const data = 'data' in command ? command.data : undefined
          if (typeof data !== 'string' || data.length > 4096)
            throw new DesktopError('invalid_request', '终端输入无效')
          return host.request('desktop.terminal', { action, terminalId, data })
        }
        case 'output':
        case 'close': return host.request('desktop.terminal', { action, terminalId })
        default: throw new DesktopError('invalid_request', '终端操作无效')
      }
    },
  }
}
