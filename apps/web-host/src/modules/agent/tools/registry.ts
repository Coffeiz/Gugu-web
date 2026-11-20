import { CoreError } from '@gugu/core'
import { createOwnerToolRegistry, type OwnerToolOptions } from '@gugu/core/tools/owner'
import type { PoolClient } from 'pg'
import type { AgentPromptDescriptionPorts, AgentRunBinding } from '@gugu/core/agent'
import type { AgentDispatchLease } from '../run/dispatch.js'
import { agentProjectDispatchKey } from './projects.js'

const WEB_AGENT_CONFIGURED_TOOL_NAMES = new Set([
  'shell', 'read_file', 'view_image', 'present_file', 'send_file', 'save_uploaded_file', 'list_recent_attachments', 'delete_folder', 'delete_file', 'list_trash', 'restore_file', 'restore_folder', 'permanent_delete',
  'search_conversations', 'search_memory', 'remember', 'read_conversation', 'get_current_time', 'get_upcoming', 'get_dashboard_stats',
  'list_events', 'list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task', 'delete_scheduled_task', 'list_workspaces', 'get_workspace',
  'list_clients', 'create_client', 'update_client', 'list_projects', 'get_project', 'create_project', 'update_project', 'delete_project',
  'delete_client',
  'set_color', 'archive_project', 'add_stage', 'remove_stage', 'rename_stage', 'set_stages', 'update_stage',
  'canvas_list', 'canvas_get', 'canvas_search', 'canvas_focus_node',
  'canvas_search_placeable', 'canvas_create', 'canvas_create_note', 'canvas_add_node', 'canvas_update_node', 'canvas_remove_node',
  'canvas_update_note', 'canvas_update_anchor', 'canvas_connect', 'canvas_delete', 'canvas_delete_note', 'canvas_disconnect',
  'canvas_batch', 'note_search', 'note_get', 'note_delete', 'note_restore', 'note_undo', 'use_skill', 'list_skills', 'create_skill', 'update_skill', 'delete_skill', 'note_create', 'note_update', 'ask_user',
  'get_tool_schema', 'call_tool', 'manage_mcp_servers', 'web_search', 'web_download', 'http_get', 'similar_image_search', 'deep_research', 'send_link_buttons', 'send_email', 'read_knowledge', 'save_knowledge', 'update_knowledge', 'delete_knowledge', 'global_search',
  'create_workspace', 'update_workspace', 'unlink_workspace', 'delete_workspace_directory', 'undo_last_action', 'create_event', 'update_event', 'delete_event',
])

/** 静态名称须在 Web 白名单内。动态 MCP 名称来自可信目录，仍由当前租约的 MCP 注册器校验。 */
export function filterConfiguredWebAgentTools(names: readonly string[]): string[] {
  return names.filter(name => WEB_AGENT_CONFIGURED_TOOL_NAMES.has(name)
    || (name.length <= 64 && /^mcp_[A-Za-z0-9_]+_[A-Za-z0-9_]+$/u.test(name)))
}

export type AgentToolRegistryOptions = Omit<OwnerToolOptions, 'projectDispatchKey'>

export function createAgentToolRegistry(options: AgentToolRegistryOptions) {
  return createOwnerToolRegistry({
    ...options,
    projectDispatchKey({ identity, roundId, toolCallId }) {
      const sessionId = Number(identity.sessionId)
      if (!/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(sessionId))
        throw new CoreError('invalid_request', '工具运行身份无效')
      const key = agentProjectDispatchKey({ sessionId, runId: identity.runId, roundId, toolCallId })
      if (!key) throw new CoreError('invalid_request', '工具运行身份无效')
      return key
    },
  })
}

export type SharedOwnerToolOptions = Pick<Parameters<typeof createAgentToolRegistry>[0],
  'projects' | 'projectMutations' | 'search' | 'conversations' | 'workspaces' | 'workspaceMutations'
  | 'viewImage' | 'fileOverview' | 'canvases' | 'canvasPlaceableSearch' | 'canvasCreation'
  | 'canvasEdits' | 'canvasPlacements' | 'canvasRelations' | 'notes' | 'noteWrites' | 'noteLifecycle'
  | 'scheduledTasks' | 'scheduledTaskWrites' | 'calendar' | 'events' | 'calendarCreate' | 'calendarUpdate' | 'calendarDelete'
  | 'knowledge' | 'knowledgeWrites' | 'skillMetadata' | 'skillManagement'>

export type ImOwnerToolFactory = (lease: AgentDispatchLease, timezone: string, authorize: () => Promise<boolean>, binding: Pick<AgentRunBinding, 'selection' | 'resolve'>) => Promise<{
  tools: SharedOwnerToolOptions & Pick<Parameters<typeof createAgentToolRegistry>[0],
    'clientDelete' | 'projectDelete' | 'scheduledTaskDelete' | 'skillDelete' | 'knowledgeDelete' | 'mcpManagement' | 'sendEmail'
    | 'canvasBatch' | 'canvasDeleteNote' | 'canvasDisconnect' | 'canvasDelete' | 'shell' | 'diskTrashTools'>
  describe?: AgentPromptDescriptionPorts<PoolClient>['describe']
}>
