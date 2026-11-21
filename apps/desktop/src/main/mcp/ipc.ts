import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { createCitationSiteLookup } from '@gugu/core/agent/citation-site'
import { createNodeProviderTransport, desktopTransportOptions } from '@gugu/core/providers/node'
import { testMcp, type McpConfig } from './connection.js'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers, IpcHost } from '../ipc/types.js'

export function resourceHandlers(host: IpcHost, resolveProxy?: Parameters<typeof testMcp>[1]): IpcHandlers {
  const tested = new Map<string, { digest: string; result: Awaited<ReturnType<typeof testMcp>> }>()
  const citationSite = createCitationSiteLookup({
    async withTransport(signal, execute) {
      signal.throwIfAborted()
      const transport = createNodeProviderTransport(desktopTransportOptions(false, resolveProxy))
      try { return await execute(transport) }
      finally { await transport.close() }
    },
  })
  return {
    [DESKTOP_CHANNELS.resources]: async command => {
      if (!command || typeof command !== 'object' || !('domain' in command) || !('action' in command))
        throw new DesktopError('invalid_request', '资源操作无效')
      const { domain, action } = command
      if (domain === 'citation' && action === 'site-name' && 'url' in command)
        return { name: await citationSite(command.url) }
      if (domain !== 'skills' && domain !== 'mcp') throw new DesktopError('invalid_request', '资源类型无效')
      const id = 'id' in command ? command.id : undefined
      const fields = 'fields' in command ? command.fields : undefined
      switch (action) {
        case 'list': {
          if (domain === 'skills') return host.request('skills.list', { offset: 'offset' in command ? command.offset : 0 })
          type ListPage = { items: Array<{ id: string; enabled: boolean; config_digest: string }>; enabled: boolean; max_servers: number | null; nextOffset?: number | null }
          const list = await host.request<ListPage>('mcp.list', { offset: 0 })
          const items = [...list.items]
          for (let offset = list.nextOffset; offset != null;) {
            const page = await host.request<ListPage>('mcp.list', { offset })
            items.push(...page.items)
            offset = page.nextOffset
          }
          const versions = new Map(items.map(item => [item.id, item.config_digest]))
          for (const [serverId, entry] of tested) if (versions.get(serverId) !== entry.digest) tested.delete(serverId)
          return { enabled: list.enabled, max_servers: list.max_servers, items: items.map(({ config_digest: _digest, ...item }) => {
            const result = tested.get(item.id)?.result
            if (!item.enabled || !result) return item
            return { ...item, state: result.ok ? 'ok' : 'error', loaded_tool_count: result.tool_count, loaded_tool_names: result.tools }
          }) }
        }
        case 'tools':
          if (domain !== 'skills') break
          return host.request('skills.tools', { offset: 'offset' in command ? command.offset : 0 })
        case 'create': return host.request(`${domain}.create`, { fields })
        case 'update': return host.request(`${domain}.update`, { id, fields })
        case 'delete': return host.request(`${domain}.delete`, { id })
        case 'config':
        case 'test':
          if (domain !== 'mcp') break
          const { config_digest, ...config } = await host.request('mcp.config', { id }) as McpConfig & { config_digest: string }
          if (action === 'config') return config
          const result = await testMcp(config, resolveProxy)
          if (typeof id === 'string' && config_digest) tested.set(id, { digest: config_digest, result })
          return result
      }
      throw new DesktopError('invalid_request', '资源操作无效')
    },
  }
}
