import type { DesktopResourceCommand } from '@gugu/core/desktop'
import type { ClawHubPreview, FileSkillPatch, McpServerItem, SkillToolItem, UserSkillItem, UserSkillWrite } from '@/services/api'
import { callDesktopBridge, DesktopBridgeError } from '@desktop/bridge/bridge'

function request<T>(command: DesktopResourceCommand): Promise<T> {
  return callDesktopBridge(bridge => {
    if (typeof bridge.resources !== 'function')
      throw new DesktopBridgeError('desktop_update_required', '请更新并重启咕咕后管理本地资源')
    return bridge.resources(JSON.parse(JSON.stringify(command)))
  }) as Promise<T>
}

export const readDesktopCitationSite = (url: string) => request<{ name: string | null }>({ domain: 'citation', action: 'site-name', url })

export const desktopSkillsApi = {
  previewClawHub: (reference: string) => request<ClawHubPreview>({ domain: 'skills', action: 'clawhub-preview', reference }),
  searchClawHub: (query: string) => request<{ skills: Array<{ slug: string; name: string; description: string; version: string | null; owner: string; reference: string; url: string }> }>({ domain: 'skills', action: 'clawhub-search', query }),
  trendingClawHub: () => request<{ skills: Array<{ slug: string; name: string; description: string; version: string | null; owner: string; reference: string; url: string; downloads?: number | null }> }>({ domain: 'skills', action: 'clawhub-trending' }),
  createFileSkill: (fields: UserSkillWrite) => request<{ id: string }>({ domain: 'skills', action: 'file-create', fields: { ...fields, description_long: fields.description_long ?? null } }),
  installClawHub: (reference: string) => request<{ id: string }>({ domain: 'skills', action: 'clawhub-install', reference }),
  updateFileSkill: (id: string, expectedDigest: string, patch: FileSkillPatch, source: 'user' | 'clawhub' = 'user') =>
    request<{ id: string }>({ domain: 'skills', action: 'file-update', id, source, expectedDigest, patch }),
  deleteFileSkill: (id: string, expectedDigest: string, source: 'user' | 'clawhub' = 'user') =>
    request<{ id: string }>({ domain: 'skills', action: 'file-delete', id, source, expectedDigest }),
  applyFileHistory: (mode: 'undo' | 'redo') => request<{ changed: boolean }>({ domain: 'skills', action: 'file-history', mode }),
  async list() {
    const skills: UserSkillItem[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const page: { skills: UserSkillItem[]; nextOffset: number | null } =
        await request({ domain: 'skills', action: 'file-list', offset })
      skills.push(...page.skills)
      offset = page.nextOffset
    }
    return { skills }
  },
  async tools() {
    const tools: SkillToolItem[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const page: { tools: SkillToolItem[]; nextOffset: number | null } =
        await request({ domain: 'skills', action: 'tools', offset })
      tools.push(...page.tools)
      offset = page.nextOffset
    }
    return { tools }
  },
}

function testMcp(id: string) {
  return request<{ ok: boolean; error?: string; tool_count: number; tools: string[] }>({ domain: 'mcp', action: 'test', id })
}

export const desktopMcpApi = {
  list: () => request<{ items: McpServerItem[]; max_servers: number | null }>({ domain: 'mcp', action: 'list' }),
  config: (id: string) => request<Pick<McpServerItem, 'endpoint' | 'credential_slots' | 'credential_values'>>({ domain: 'mcp', action: 'config', id }),
  create: (fields: Record<string, unknown>) => request<{ id: string }>({ domain: 'mcp', action: 'create', fields }),
  update: (id: string, fields: Record<string, unknown>) => request<{ id: string }>({ domain: 'mcp', action: 'update', id, fields }),
  remove: (id: string) => request({ domain: 'mcp', action: 'delete', id }),
  test: testMcp,
  async reconnect(id: string) {
    const result = await testMcp(id)
    return { ...result, state: result.ok ? 'ok' : 'error', tool_names: result.tools }
  },
}
