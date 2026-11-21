import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { testMcp, type McpConfig } from './connection.js'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers, IpcHost } from '../ipc/types.js'

export function resourceHandlers(host: IpcHost, resolveProxy?: Parameters<typeof testMcp>[1]): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.resources]: async command => {
      if (!command || typeof command !== 'object' || !('domain' in command) || !('action' in command))
        throw new DesktopError('invalid_request', '资源操作无效')
      const { domain, action } = command
      if (domain !== 'skills' && domain !== 'mcp') throw new DesktopError('invalid_request', '资源类型无效')
      const id = 'id' in command ? command.id : undefined
      const fields = 'fields' in command ? command.fields : undefined
      switch (action) {
        case 'list': return host.request(`${domain}.list`, domain === 'skills' ? { offset: 'offset' in command ? command.offset : 0 } : {})
        case 'tools':
          if (domain !== 'skills') break
          return host.request('skills.tools', { offset: 'offset' in command ? command.offset : 0 })
        case 'create': return host.request(`${domain}.create`, { fields })
        case 'update': return host.request(`${domain}.update`, { id, fields })
        case 'delete': return host.request(`${domain}.delete`, { id })
        case 'config':
        case 'test':
          if (domain !== 'mcp') break
          const config = await host.request('mcp.config', { id }) as McpConfig
          return action === 'test' ? testMcp(config, resolveProxy) : config
      }
      throw new DesktopError('invalid_request', '资源操作无效')
    },
  }
}
