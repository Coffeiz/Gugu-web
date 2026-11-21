import { filterConfiguredAgentTools } from '@gugu/core/agent'
import { createOwnerToolRegistry, type OwnerToolOptions } from '@gugu/core/tools/owner'
import type { PoolClient } from 'pg'
import type { AgentPromptDescriptionPorts, AgentRunBinding } from '@gugu/core/agent'
import type { AgentDispatchLease } from '../run/dispatch.js'

/** 静态名称须在 Web 白名单内。动态 MCP 名称来自可信目录，仍由当前租约的 MCP 注册器校验。 */
export function filterConfiguredWebAgentTools(names: readonly string[]): string[] {
  return filterConfiguredAgentTools(names)
}

export type AgentToolRegistryOptions = OwnerToolOptions
export { createOwnerToolRegistry as createAgentToolRegistry }

export type SharedOwnerToolOptions = Pick<AgentToolRegistryOptions,
  'projects' | 'projectMutations' | 'search' | 'conversations' | 'workspaces' | 'workspaceMutations'
  | 'viewImage' | 'fileOverview' | 'canvases' | 'canvasPlaceableSearch' | 'canvasCreation'
  | 'canvasEdits' | 'canvasPlacements' | 'canvasRelations' | 'notes' | 'noteWrites' | 'noteLifecycle'
  | 'scheduledTasks' | 'scheduledTaskWrites' | 'calendar' | 'events' | 'calendarCreate' | 'calendarUpdate' | 'calendarDelete'
  | 'knowledge' | 'knowledgeWrites' | 'skillMetadata' | 'skillManagement'>

export type ImOwnerToolFactory = (lease: AgentDispatchLease, timezone: string, authorize: () => Promise<boolean>, binding: Pick<AgentRunBinding, 'selection' | 'resolve'>) => Promise<{
  tools: SharedOwnerToolOptions & Pick<AgentToolRegistryOptions,
    'clientDelete' | 'projectDelete' | 'scheduledTaskDelete' | 'skillDelete' | 'knowledgeDelete' | 'mcpManagement' | 'sendEmail'
    | 'canvasBatch' | 'canvasDeleteNote' | 'canvasDisconnect' | 'canvasDelete' | 'shell' | 'diskTrashTools'>
  describe?: AgentPromptDescriptionPorts<PoolClient>['describe']
}>
