import { createNoteLifecycleTools,type NoteLifecyclePort } from '@gugu/core/tools'
import { createLinkButtonsTools, type LinkButtonDeliveryPort } from '@gugu/core/tools'
import { createAskUserTool } from '@gugu/core/tools'
import { createTrashRestoreTools, type TrashRestorePort } from '@gugu/core/tools'
import { createConversationReadTool, createConversationSearchTool, type ConversationReadPort, type ConversationSearchPort } from '@gugu/core/tools'
import { createMemorySearchTool, type MemorySearchPort } from '@gugu/core/tools'
import { createCanvasPlacementTools, createCanvasRelationTools, createCanvasEditTools, type CanvasEditPort } from '@gugu/core/tools'
import { createCanvasPlaceableSearchTool, createCanvasCreateTool, createSkillManagementReadTools, createSkillManagementWriteTools } from '@gugu/core/tools'
import type { CanvasCreatePort, SkillMetadataListPort } from '@gugu/core/tools'
import type { createUserSkillManager } from '@gugu/core/agent/skills/user-management'
import type { createAgentPlaceableSearch } from '@gugu/core/mind'
import type { AgentCanvasReader } from '@gugu/core/tools'
import type { createAgentCalendarReader, CalendarEventReadPort } from '@gugu/core/calendar'
import type { createAgentMindReader } from '@gugu/core/mind'
import type { SqlDataRuntime } from '@gugu/core/data'
import { CoreError, type GlobalSearchOperations, type DashboardCountPort, type createAgentWorkspaceQueries } from '@gugu/core'
import type { RunIdentity } from '@gugu/core/agent'
import { createClientTools, createCanvasReadTools, createWorkspaceUpdateTool, createNoteReadTools, createGetToolSchemaTool, createProjectStageTools, createListEventsTool, createWorkspaceReadTools, createDashboardStatsTool, createProjectMutationTools, createGlobalSearchTool, createUpcomingTool, createListTrashTool, createGetProjectTool, createListProjectsTool, createListScheduledTasksTool, createProjectCreationPort, createProjectTool, createTimeTool, createToolRegistry, createUseSkillTool } from '@gugu/core/tools'
import type { WorkspaceMutationPort, ProjectMutationPort, TrashListPort, ProjectFileOverview, ScheduledTaskListPort, UseSkillPorts } from '@gugu/core/tools'
import type { ProjectCreateRuntime } from '@gugu/core/project-create'
import { agentProjectDispatchKey } from './agent-project-tool.js'

type AuthorizedToolName = 'create_project' | 'list_clients' | 'create_client' | 'update_client' | 'list_projects' | 'get_project' | 'get_current_time' | 'use_skill' | 'list_scheduled_tasks' | 'global_search' | 'get_upcoming' | 'list_trash' | 'list_events' | 'list_workspaces' | 'get_workspace' | 'get_dashboard_stats' | 'update_project' | 'set_color' | 'archive_project' | 'add_stage' | 'remove_stage' | 'rename_stage' | 'set_stages' | 'update_stage' | 'note_search' | 'note_get' | 'get_tool_schema' | 'canvas_list' | 'canvas_get' | 'canvas_search' | 'canvas_focus_node' | 'update_workspace' | 'canvas_search_placeable' | 'canvas_create' | 'list_skills' | 'create_skill' | 'update_skill' | 'canvas_update_node' | 'canvas_remove_node' | 'canvas_update_note' | 'canvas_create_note' | 'canvas_add_node' | 'canvas_update_anchor' | 'canvas_connect' | 'note_delete' | 'note_restore' | 'note_undo'

export interface AgentToolRegistryOptions {
  core: SqlDataRuntime
  /** 没有可信项目创建后端时，不开放创建工具。 */
  projects?: ProjectCreateRuntime
  /** 可信权限服务；模型输出不得决定此权限。 */
  authorize(identity: RunIdentity, name: AuthorizedToolName | 'send_link_buttons' | 'ask_user' | 'restore_file' | 'restore_folder' | 'read_conversation' | 'search_conversations' | 'search_memory'): Promise<boolean>
  /** 历史正文读取必须限定可信 owner；缺少共享读取服务时不开放。 */
  conversations?: ConversationReadPort
  /** 必须同时提供 owner 限定的 RAG 与会话定位能力。 */
  conversationSearch?: ConversationSearchPort
  /** Memory 文件、scope ACL、授权和可选 embedding 均须由可信 Host 完整提供。 */
  memorySearch?: MemorySearchPort
  /** Host 已装配普通问题激活和回答消费时显式开放。 */
  askUser?: boolean
  /** 仅提供可信渠道与可恢复投递时开放；不会推断或降级渠道。 */
  linkButtons?: LinkButtonDeliveryPort
  /** 未提供可信用户时区时，不能开放时间工具。 */
  time?: { now(): Date; timezone(identity: RunIdentity): Promise<string> }
  /** 仅在可按用户和项目安全读取文件概览时开放项目详情。 */
  fileOverview?: (identity: RunIdentity, projectId: number, signal: AbortSignal) => Promise<ProjectFileOverview>
  /** 技能来源和用户权限由可信 Host 提供；缺少能力时不开放。 */
  skills?: UseSkillPorts
  /** 平台和授权边界完备的定时任务共享只读服务。 */
  scheduledTasks?: ScheduledTaskListPort
  /** 复用共享搜索服务，来源能力由可信 Host 明确装配。 */
  search?: GlobalSearchOperations
  /** 可信日历读取能力；近期待办同时依赖用户时区。 */
  events?: CalendarEventReadPort
  trash?: TrashListPort
  /** 文件恢复后端需提供持久防重放和归属校验。 */
  trashRestore?: TrashRestorePort
  canvasPlaceableSearch?: ReturnType<typeof createAgentPlaceableSearch>
  canvasPlacements?: CanvasEditPort
  canvasRelations?: CanvasEditPort
  canvasEdits?: CanvasEditPort
  canvasCreation?: CanvasCreatePort
  skillMetadata?: SkillMetadataListPort
  /** 用户 Skill 创建和更新通过共享领域服务执行；删除等待确认协议接入。 */
  skillManagement?: Pick<ReturnType<typeof createUserSkillManager>, 'create' | 'update'>
  canvases?: AgentCanvasReader
  workspaceMutations?: WorkspaceMutationPort
  noteLifecycle?: NoteLifecyclePort
  notes?: ReturnType<typeof createAgentMindReader>
  calendar?: ReturnType<typeof createAgentCalendarReader>
  workspaces?: ReturnType<typeof createAgentWorkspaceQueries>
  dashboard?: DashboardCountPort
  /** 必须提供收据恢复能力；旧的仅apply桥接不会被Host开放。 */
  projectMutations?: ProjectMutationPort
}

/** 复用 Core 注册器和 Host 项目事务；危险工具未接确认门前不注册。 */
export function createAgentToolRegistry(options: AgentToolRegistryOptions) {
  const createProject = options.projects ? createProjectCreationPort({ runtime: options.projects, keyForCall({ identity, roundId, toolCallId }) {
    const sessionId = Number(identity.sessionId)
    if (!/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(sessionId)) throw new CoreError('invalid_request', '工具运行身份无效')
    const key = agentProjectDispatchKey({ sessionId, runId: identity.runId, roundId, toolCallId })
    if (!key) throw new CoreError('invalid_request', '工具运行身份无效')
    return key
  } }) : null
  const registry: ReturnType<typeof createToolRegistry> = createToolRegistry({
    groups: [
      { id: 'clients', name: '联系人', tools: createClientTools(options.core) },
      ...(options.conversations || options.conversationSearch ? [{ id:'conversations', name:'历史对话', tools:[...(options.conversations?[createConversationReadTool(options.conversations)]:[]),...(options.conversationSearch?[createConversationSearchTool(options.conversationSearch)]:[])] }] : []),
      ...(options.memorySearch ? [{ id:'memory', name:'记忆', tools:[createMemorySearchTool(options.memorySearch)] }] : []),
      ...(options.linkButtons ? [{ id:'link_buttons', name:'链接按钮', tools:createLinkButtonsTools(options.linkButtons) }] : []),
      { id: 'projects', name: '项目', tools: [
        createListProjectsTool(options.core),
        ...(options.fileOverview ? [createGetProjectTool({ core: options.core, fileOverview: options.fileOverview })] : []),
        ...(createProject ? [createProjectTool(createProject)] : []),
        ...(options.projectMutations?.reconcile ? [...createProjectMutationTools(options.projectMutations),...createProjectStageTools(options.projectMutations)] : []),
      ] },
      ...(options.time && (options.events || options.dashboard) ? [{ id: 'overview', name: '总览', tools: [
        ...(options.events ? [createUpcomingTool({ core: options.core, events: options.events, time: options.time })] : []),
        ...(options.dashboard ? [createDashboardStatsTool({ counts: options.dashboard, time: options.time })] : []),
      ] }] : []),
      ...(options.calendar ? [{ id: 'calendar', name: '日历', tools: [createListEventsTool(options.calendar)] }] : []),
      ...(options.workspaces || options.workspaceMutations ? [{ id: 'workspaces', name: '工作区', tools: [
        ...(options.workspaces ? createWorkspaceReadTools(options.workspaces) : []),
        ...(options.workspaceMutations ? [createWorkspaceUpdateTool(options.workspaceMutations)] : []),
      ] }] : []),
      ...(options.canvases || options.canvasPlaceableSearch || options.canvasCreation || options.canvasEdits || options.canvasPlacements || options.canvasRelations ? [{id:'canvas',name:'画布',tools:[
        ...(options.canvases ? createCanvasReadTools(options.canvases) : []),
        ...(options.canvasEdits ? createCanvasEditTools(options.canvasEdits) : []),
        ...(options.canvasPlacements ? createCanvasPlacementTools(options.canvasPlacements) : []),
        ...(options.canvasRelations ? createCanvasRelationTools(options.canvasRelations) : []),
        ...(options.canvasPlaceableSearch ? [createCanvasPlaceableSearchTool(options.canvasPlaceableSearch)] : []),
        ...(options.canvasCreation ? [createCanvasCreateTool(options.canvasCreation)] : []),
      ]}] : []),
      ...(options.skillMetadata || options.skillManagement ? [{id:'skill_management',name:'技能管理',tools:[...(options.skillMetadata?createSkillManagementReadTools(options.skillMetadata):[]),...(options.skillManagement?createSkillManagementWriteTools(options.skillManagement):[])]}] : []),
      ...(options.trash || options.trashRestore ? [{ id: 'trash', name: '回收站', tools: [...(options.trash?[createListTrashTool(options.trash)]:[]),...(options.trashRestore?createTrashRestoreTools(options.trashRestore):[])] }] : []),
      ...(options.search ? [{ id: 'global_search', name: '站内搜索', tools: [createGlobalSearchTool(options.search)] }] : []),
      ...(options.time ? [{ id: 'time', name: '时间', tools: [createTimeTool(options.time)] }] : []),
      { id: 'meta', name: '元工具', tools: [createGetToolSchemaTool(identity=>registry.capabilities(identity)),...(options.skills?[createUseSkillTool(options.skills)]:[]),...(options.askUser?[createAskUserTool()]:[])] },
      ...(options.notes || options.noteLifecycle ? [{id:'mind',name:'思维笔记',tools:[...(options.notes?createNoteReadTools(options.notes):[]),...(options.noteLifecycle?createNoteLifecycleTools(options.noteLifecycle):[])]}] : []),
      ...(options.scheduledTasks ? [{ id: 'scheduled_tasks', name: '定时任务', tools: [createListScheduledTasksTool(options.scheduledTasks)] }] : []),
    ],
    authorize: (identity, name) => options.authorize(identity, name as AuthorizedToolName | 'send_link_buttons' | 'ask_user' | 'restore_file' | 'restore_folder' | 'read_conversation' | 'search_conversations' | 'search_memory'),
  })
  return registry
}
