import type { InjectionKey } from 'vue'
import type { McpServerItem, mcpApi, userSkillsApi } from './api'

type SkillsApi = Pick<typeof userSkillsApi, 'list' | 'tools' | 'searchClawHub' | 'trendingClawHub' | 'previewClawHub' | 'installClawHub' | 'createFileSkill' | 'updateFileSkill' | 'deleteFileSkill'>

type McpApi = {
  list(): Promise<{ items: McpServerItem[]; max_servers: number | null }>
  create(fields: Record<string, unknown>): Promise<{ id: string }>
  update(id: string, fields: Record<string, unknown>): Promise<{ id: string }>
  remove(id: string): Promise<unknown>
  test: typeof mcpApi.test
  reconnect(id: string): Promise<{ ok: boolean; state: string; tool_count: number; tool_names?: string[]; error?: string }>
  config?(id: string): Promise<Pick<McpServerItem, 'endpoint' | 'credential_slots' | 'credential_values'>>
}

export const skillAccessKey: InjectionKey<{ api: SkillsApi; configureWithChat: boolean }> = Symbol('skillAccess')
export const mcpAccessKey: InjectionKey<{
  api: McpApi
  httpOnly: boolean
  configureWithChat: boolean
  refreshMissingStatuses: boolean
}> = Symbol('mcpAccess')
