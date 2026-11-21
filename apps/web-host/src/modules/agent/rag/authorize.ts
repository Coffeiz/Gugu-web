import { canonicalAgentToolName } from '@gugu/core/agent'
import type { CanonicalRunPreparationPorts, RunIdentity } from '@gugu/core/agent'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../run/dispatch.js'

const RAG_TOOLS = new Set(['search_conversations', 'search_memory', 'use_skill', 'list_skills'])
const SKILL_WRITE_TOOLS = ['create_skill', 'update_skill'] as const
const ASK_USER_TOOLS = new Set(['ask_user'])
const LINK_BUTTON_TOOLS = new Set(['send_link_buttons'])
const IMAGE_VIEW_TOOLS = new Set(['view_image'])
const FILE_READ_TOOLS = new Set(['read_file'])
const FILE_PRESENT_TOOLS = new Set(['present_file'])
const FILE_FOLDER_DELETE_TOOLS = new Set(['delete_folder'])
const FILE_DELETE_TOOLS = new Set(['delete_file'])
const FILE_SEND_TOOLS = new Set(['send_file'])
const FILE_SAVE_ATTACHMENT_TOOLS = new Set(['save_attachment'])
const FILE_RECENT_ATTACHMENT_TOOLS = new Set(['list_recent_attachments'])
const CORE_READ_TOOLS = new Set(['list_contacts', 'list_projects', 'search_tools'])
const PROJECT_CREATE_TOOLS = new Set(['create_project'])
const PROJECT_MUTATION_TOOLS = new Set(['update_project', 'set_color', 'archive_project', 'add_stage', 'remove_stage', 'rename_stage', 'set_stages', 'update_stage'])
const PROJECT_DETAIL_TOOLS = new Set(['get_project'])
const CONVERSATION_READ_TOOLS = new Set(['read_conversation'])
const TIME_TOOLS = new Set(['get_current_time'])
const KNOWLEDGE_TOOLS = new Set(['read_knowledge'])
const KNOWLEDGE_WRITE_TOOLS = new Set(['save_knowledge', 'update_knowledge'])
const GLOBAL_SEARCH_TOOLS = new Set(['global_search'])
const CLIENT_TOOLS = new Set(['list_contacts', 'create_contact', 'update_contact'])
const CLIENT_DELETE_TOOLS = new Set(['delete_contact'])
const CALENDAR_READ_TOOLS = new Set(['list_events'])
const UPCOMING_TOOLS = new Set(['get_upcoming'])
const DASHBOARD_TOOLS = new Set(['get_dashboard_stats'])
const SCHEDULED_TASK_TOOLS = new Set(['list_scheduled_tasks'])
const WORKSPACE_READ_TOOLS = new Set(['list_workspaces', 'get_workspace'])
const WORKSPACE_CREATE_TOOLS = new Set(['create_workspace'])
const WORKSPACE_WRITE_TOOLS = new Set(['update_workspace'])
const WORKSPACE_UNLINK_TOOLS = new Set(['unlink_workspace'])
const WORKSPACE_DIRECTORY_DELETE_TOOLS = new Set(['delete_workspace_directory'])
const UNDO_LAST_ACTION_TOOLS = new Set(['undo_last_action'])
const TRASH_READ_TOOLS = new Set(['list_trash'])
const TRASH_RESTORE_TOOLS = new Set(['restore_file', 'restore_folder'])
const TRASH_PURGE_TOOLS = new Set(['permanent_delete'])
const CANVAS_READ_TOOLS = new Set(['canvas_list', 'canvas_get', 'canvas_search', 'canvas_focus_node'])
const CANVAS_PLACEABLE_SEARCH_TOOLS = new Set(['canvas_search_placeable'])
const CANVAS_CREATE_TOOLS = new Set(['canvas_create'])
const CANVAS_MUTATION_TOOLS = new Set([
  'canvas_create_note', 'canvas_add_node', 'canvas_update_node', 'canvas_remove_node',
  'canvas_update_note', 'canvas_update_anchor', 'canvas_connect',
])
const NOTE_LIFECYCLE_TOOLS = new Set(['note_delete', 'note_restore', 'note_undo'])
const NOTE_READ_TOOLS = new Set(['note_search', 'note_get'])
const WEB_CALENDAR_CANVAS_TOOLS = new Set([
  'create_event', 'update_event', 'delete_event',
  'canvas_delete', 'canvas_delete_note', 'canvas_disconnect', 'canvas_batch',
])

export type WebCalendarCanvasToolName =
  | 'create_event' | 'update_event' | 'delete_event'
  | 'canvas_delete' | 'canvas_delete_note' | 'canvas_disconnect' | 'canvas_batch'

/**
 * Web Run 的可信配置与执行授权：只读历史正文也必须由 Host 提供端口后显式启用；
 * 日历/画布写工具同样按本次装配显式列入，并在发现和执行时重验 PostgreSQL dispatch lease。
 */
export function createWebAgentRagRunAuthorization(
  pool: Pick<Pool, 'query'>,
  lease: AgentDispatchLease,
  options: { enabledShell?: boolean; enabledCalendarCanvasTools?: readonly WebCalendarCanvasToolName[]; enabledConversationRead?: boolean; enabledTime?: boolean; enabledRemember?: boolean; enabledKnowledgeRead?: boolean; enabledKnowledgeWrites?: boolean; enabledKnowledgeDelete?: boolean; enabledGlobalSearch?: boolean; enabledAskUser?: boolean; enabledSkillManagement?: boolean; enabledSkillDelete?: boolean; enabledNoteWrites?: boolean; enabledCallTool?: boolean; enabledMcpManagement?: boolean; enabledScheduledTaskWrites?: boolean; enabledScheduledTaskDelete?: boolean; enabledSendEmail?: boolean; enabledHttpGet?: boolean; enabledWebSearch?: boolean; enabledWebDownload?: boolean; enabledSimilarImageSearch?: boolean; enabledDeepResearch?: boolean; enabledLinkButtons?: boolean; enabledFileRead?: boolean; enabledImageView?: boolean; enabledFilePresent?: boolean; enabledFileFolderDelete?: boolean; enabledFileDelete?: boolean; enabledSaveAttachment?: boolean; enabledRecentAttachments?: boolean; enabledSendFile?: boolean; enabledCalendarRead?: boolean; enabledUpcoming?: boolean; enabledClientTools?: boolean; enabledClientDelete?: boolean; enabledDashboard?: boolean; enabledProjectOverview?: boolean; enabledProjectCreation?: boolean; enabledProjectMutations?: boolean; enabledProjectDelete?: boolean; enabledWorkspaces?: boolean; enabledWorkspaceMutations?: boolean; enabledWorkspaceCreation?: boolean; enabledWorkspaceUnlink?: boolean; enabledWorkspaceDirectoryDelete?: boolean; enabledUndoLastAction?: boolean; enabledScheduledTasks?: boolean; enabledTrashList?: boolean; enabledTrashRestore?: boolean; enabledTrashPurge?: boolean; enabledCanvasReads?: boolean; enabledCanvasPlaceableSearch?: boolean; enabledCanvasCreate?: boolean; enabledCanvasMutations?: boolean; enabledNoteReads?: boolean; enabledNoteLifecycle?: boolean } = {},
): {
  configuration: CanonicalRunPreparationPorts['configuration']
  authorize(identity: RunIdentity, name: string, signal?: AbortSignal): Promise<boolean>
} {
  const enabledCalendarCanvasTools = options.enabledCalendarCanvasTools ?? []
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent RAG 运行来源无法验证')
  if (!Array.isArray(enabledCalendarCanvasTools)
    || enabledCalendarCanvasTools.some(name => !WEB_CALENDAR_CANVAS_TOOLS.has(name)))
    throw new TypeError('Web Agent 日历/画布工具授权配置无效')
  const expected = Object.freeze({ ...lease.identity })
  const allowed = new Set<string>([...RAG_TOOLS, ...CORE_READ_TOOLS,
    ...(options.enabledSendEmail === true ? ['send_email'] : []),
    ...(options.enabledScheduledTaskWrites === true ? ['create_scheduled_task', 'update_scheduled_task'] : []),
    ...(options.enabledScheduledTaskDelete === true ? ['delete_scheduled_task'] : []),
    ...(options.enabledMcpManagement === true ? ['manage_mcp_servers'] : []),
    ...(options.enabledCallTool === true ? ['call_tool'] : []),
    ...(options.enabledSimilarImageSearch === true ? ['similar_image_search'] : []),
    ...(options.enabledHttpGet === true ? ['http_get'] : []),
    ...(options.enabledWebDownload === true ? ['web_download'] : []),
    ...(options.enabledWebSearch === true ? ['web_search'] : []),
    ...(options.enabledDeepResearch === true ? ['deep_research'] : []),
    ...(options.enabledSkillDelete === true ? ['delete_skill'] : []),
    ...(options.enabledNoteWrites === true ? ['note_create', 'note_update'] : []),
    ...(options.enabledSkillManagement === true ? SKILL_WRITE_TOOLS : []),
    ...(options.enabledAskUser === true ? ASK_USER_TOOLS : []),
    ...(options.enabledLinkButtons === true ? LINK_BUTTON_TOOLS : []),
    ...(options.enabledShell ? ['shell'] : []),
    ...(options.enabledImageView === true ? IMAGE_VIEW_TOOLS : []),
    ...(options.enabledFileRead === true ? FILE_READ_TOOLS : []),
    ...(options.enabledFilePresent === true ? FILE_PRESENT_TOOLS : []),
    ...(options.enabledFileFolderDelete === true ? FILE_FOLDER_DELETE_TOOLS : []),
    ...(options.enabledFileDelete === true ? FILE_DELETE_TOOLS : []),
    ...(options.enabledSaveAttachment === true ? FILE_SAVE_ATTACHMENT_TOOLS : []),
    ...(options.enabledRecentAttachments === true ? FILE_RECENT_ATTACHMENT_TOOLS : []),
    ...(options.enabledSendFile === true ? FILE_SEND_TOOLS : []),
    ...(options.enabledConversationRead === true ? CONVERSATION_READ_TOOLS : []),
    ...(options.enabledTime === true ? TIME_TOOLS : []),
    ...(options.enabledRemember === true ? ['remember'] : []),
    ...(options.enabledKnowledgeRead === true ? KNOWLEDGE_TOOLS : []),
    ...(options.enabledKnowledgeDelete === true ? ['delete_knowledge'] : []),
    ...(options.enabledKnowledgeWrites === true ? KNOWLEDGE_WRITE_TOOLS : []),
    ...(options.enabledGlobalSearch === true ? GLOBAL_SEARCH_TOOLS : []),
    ...(options.enabledClientTools === true ? CLIENT_TOOLS : []),
    ...(options.enabledClientDelete === true ? CLIENT_DELETE_TOOLS : []),
    ...(options.enabledCalendarRead === true ? CALENDAR_READ_TOOLS : []),
    ...(options.enabledUpcoming === true ? UPCOMING_TOOLS : []),
    ...(options.enabledDashboard === true ? DASHBOARD_TOOLS : []),
    ...(options.enabledProjectOverview === true ? PROJECT_DETAIL_TOOLS : []),
    ...(options.enabledProjectCreation === true ? PROJECT_CREATE_TOOLS : []),
    ...(options.enabledProjectDelete === true ? ['delete_project'] : []),
    ...(options.enabledProjectMutations === true ? PROJECT_MUTATION_TOOLS : []),
    ...(options.enabledScheduledTasks === true ? SCHEDULED_TASK_TOOLS : []),
    ...(options.enabledWorkspaces === true ? WORKSPACE_READ_TOOLS : []),
    ...(options.enabledWorkspaceMutations === true ? WORKSPACE_WRITE_TOOLS : []),
    ...(options.enabledWorkspaceCreation === true ? WORKSPACE_CREATE_TOOLS : []),
    ...(options.enabledWorkspaceUnlink === true ? WORKSPACE_UNLINK_TOOLS : []),
    ...(options.enabledWorkspaceDirectoryDelete === true ? WORKSPACE_DIRECTORY_DELETE_TOOLS : []),
    ...(options.enabledUndoLastAction === true ? UNDO_LAST_ACTION_TOOLS : []),
    ...(options.enabledTrashList === true ? TRASH_READ_TOOLS : []),
    ...(options.enabledTrashRestore === true ? TRASH_RESTORE_TOOLS : []),
    ...(options.enabledTrashPurge === true ? TRASH_PURGE_TOOLS : []),
    ...(options.enabledCanvasReads === true ? CANVAS_READ_TOOLS : []),
    ...(options.enabledCanvasPlaceableSearch === true ? CANVAS_PLACEABLE_SEARCH_TOOLS : []),
    ...(options.enabledCanvasCreate === true ? CANVAS_CREATE_TOOLS : []),
    ...(options.enabledCanvasMutations === true ? CANVAS_MUTATION_TOOLS : []),
    ...(options.enabledNoteReads === true ? NOTE_READ_TOOLS : []),
    ...(options.enabledNoteLifecycle === true ? NOTE_LIFECYCLE_TOOLS : []),
    ...enabledCalendarCanvasTools])
  const names = Object.freeze([...allowed])
  const same = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId
  const active = async (identity: RunIdentity, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted()
    if (!same(identity)) return false
    const result = await pool.query(`SELECT 1 FROM conversation_sessions s
      JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3
        AND d.run_id=$3 AND d.state='selected' AND d.token=$4 AND d.fence=$5
        AND d.lease_expires_at>clock_timestamp()`,
    [expected.ownerId, expected.sessionId, expected.runId, lease.token, lease.fence])
    signal.throwIfAborted()
    return result.rowCount === 1
  }
  return {
    async configuration(identity, signal) {
      if (!await active(identity, signal)) throw new Error('Web Agent RAG 运行授权不可用')
      return {
        identity: { ownerId: expected.ownerId, workspaceId: null, subject: { kind: 'session', id: expected.sessionId } },
        source: 'web',
        toolNames: names,
      }
    },
    async authorize(identity, name, signal = new AbortController().signal) {
      return allowed.has(canonicalAgentToolName(name)) && await active(identity, signal)
    },
  }
}
