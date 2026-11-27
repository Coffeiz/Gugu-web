import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { createClawHubPreview, createClawHubSearchWithTransport, createClawHubTrendingWithTransport } from '@gugu/core/skills'
import { createCitationSiteLookup } from '@gugu/core/agent/citation-site'
import { createNodeProviderTransport, desktopTransportOptions } from '@gugu/core/providers/node'
import { testMcp, type McpConfig } from './connection.js'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers, IpcHost } from '../ipc/types.js'
import type { SkillDocumentPatch } from '@gugu/core/skills'

function validFileSkillPatch(value: unknown): value is SkillDocumentPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, field]) => {
    if (['name', 'description', 'body', 'category'].includes(key)) return typeof field === 'string'
    if (key === 'descriptionLong') return field === null || typeof field === 'string'
    if (key === 'enabled') return typeof field === 'boolean'
    if (key === 'relatedTools') return Array.isArray(field) && field.every(item => typeof item === 'string')
    return false
  })
}

type FileSkillFields = { name: string; description_short: string; description_long: string | null; category: string; body: string; related_tools: string[]; enabled?: boolean }

function validFileSkillFields(value: unknown): value is FileSkillFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = value as Record<string, unknown>
  return ['name', 'description_short', 'category', 'body'].every(key => typeof fields[key] === 'string')
    && (fields.description_long === null || typeof fields.description_long === 'string')
    && Array.isArray(fields.related_tools) && fields.related_tools.every(tool => typeof tool === 'string')
    && (fields.enabled === undefined || typeof fields.enabled === 'boolean')
    && Object.keys(fields).every(key => ['name', 'description_short', 'description_long', 'category', 'body', 'related_tools', 'enabled'].includes(key))
}

export function resourceHandlers(host: IpcHost, resolveProxy?: Parameters<typeof testMcp>[1],
  installClawHub?: (reference: string) => Promise<{ id: string }>,
  listFileSkills?: () => Promise<{ skills: unknown[] }>,
  updateFileSkill?: (id: string, expectedDigest: string, patch: SkillDocumentPatch, source: 'user' | 'clawhub') => Promise<{ id: string }>,
  deleteFileSkill?: (id: string, expectedDigest: string, source: 'user' | 'clawhub') => Promise<{ id: string }>,
  skillHistory?: (mode: 'undo' | 'redo') => Promise<{ changed: boolean }>,
  createFileSkill?: (fields: { name: string; description_short: string; description_long: string | null; category: string; body: string; related_tools: string[]; enabled?: boolean }) => Promise<{ id: string }>): IpcHandlers {
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
      if (domain === 'skills' && action === 'clawhub-search' && 'query' in command && typeof command.query === 'string') {
        const transport = createNodeProviderTransport(desktopTransportOptions(false, resolveProxy))
        try { return { skills: await createClawHubSearchWithTransport(transport)(command.query, AbortSignal.timeout(15_000)) } }
        finally { await transport.close() }
      }
      if (domain === 'skills' && action === 'clawhub-trending') {
        const transport = createNodeProviderTransport(desktopTransportOptions(false, resolveProxy))
        try { return { skills: await createClawHubTrendingWithTransport(transport)(AbortSignal.timeout(15_000)) } }
        finally { await transport.close() }
      }
      if (domain === 'skills' && action === 'clawhub-preview' && 'reference' in command && typeof command.reference === 'string') {
        const transport = createNodeProviderTransport(desktopTransportOptions(false, resolveProxy))
        try { return await createClawHubPreview(transport)(command.reference, AbortSignal.timeout(30_000)) }
        catch { throw new DesktopError('storage_error', '技能详情暂不可用') }
        finally { await transport.close() }
      }
      if (domain === 'skills' && action === 'clawhub-install' && 'reference' in command && typeof command.reference === 'string') {
        if (!installClawHub) throw new DesktopError('unsupported', '技能安装暂不可用')
        return installClawHub(command.reference)
      }
      if (domain === 'skills' && action === 'file-create') {
        const fields = 'fields' in command ? command.fields : null
        if (!validFileSkillFields(fields))
          throw new DesktopError('invalid_request', '技能参数无效')
        if (!createFileSkill) throw new DesktopError('unsupported', '技能新建暂不可用')
        return createFileSkill(fields)
      }
      if (domain === 'skills' && action === 'file-update') {
        if (!('id' in command) || typeof command.id !== 'string' || !('source' in command) || (command.source !== 'user' && command.source !== 'clawhub')
          || !('expectedDigest' in command) || typeof command.expectedDigest !== 'string'
          || !('patch' in command) || !validFileSkillPatch(command.patch)
          || Object.keys(command).some(key => !['domain', 'action', 'id', 'source', 'expectedDigest', 'patch'].includes(key)))
          throw new DesktopError('invalid_request', '技能更新参数无效')
        if (!updateFileSkill) throw new DesktopError('unsupported', '技能更新暂不可用')
        return updateFileSkill(command.id, command.expectedDigest, command.patch, command.source)
      }
      if (domain === 'skills' && action === 'file-delete') {
        if (!('id' in command) || typeof command.id !== 'string' || !('source' in command) || (command.source !== 'user' && command.source !== 'clawhub')
          || !('expectedDigest' in command) || typeof command.expectedDigest !== 'string'
          || Object.keys(command).some(key => !['domain', 'action', 'id', 'source', 'expectedDigest'].includes(key)))
          throw new DesktopError('invalid_request', '技能删除参数无效')
        if (!deleteFileSkill) throw new DesktopError('unsupported', '技能删除暂不可用')
        return deleteFileSkill(command.id, command.expectedDigest, command.source)
      }
      if (domain === 'skills' && action === 'file-history') {
        if (!('mode' in command) || (command.mode !== 'undo' && command.mode !== 'redo'))
          throw new DesktopError('invalid_request', '技能历史操作无效')
        if (!skillHistory) throw new DesktopError('unsupported', '技能历史暂不可用')
        return skillHistory(command.mode)
      }
      // IPC 来自渲染进程，不能只依赖 TypeScript 联合类型限制旧技能命令。
      if (domain === 'skills' && ['list', 'create', 'update', 'delete'].includes(String(action)))
        throw new DesktopError('invalid_request', '技能管理使用文件目录')
      const id = 'id' in command ? command.id : undefined
      const fields = 'fields' in command ? command.fields : undefined
      switch (action) {
        case 'file-list': {
          if (domain !== 'skills' || !listFileSkills) break
          const offset = 'offset' in command && typeof command.offset === 'number' ? command.offset : 0
          if (!Number.isSafeInteger(offset) || offset < 0) throw new DesktopError('invalid_request', '技能分页无效')
          const { skills } = await listFileSkills()
          return { skills: skills.slice(offset, offset + 1), nextOffset: offset + 1 < skills.length ? offset + 1 : null }
        }
        case 'list': {
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
