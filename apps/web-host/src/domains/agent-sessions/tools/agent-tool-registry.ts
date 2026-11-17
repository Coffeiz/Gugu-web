import { createNoteLifecycleTools,type NoteLifecyclePort } from '@gugu/core/tools'
import { createLinkButtonsTools, type LinkButtonDeliveryPort } from '@gugu/core/tools'
import { createAskUserTool } from '@gugu/core/tools'
import { createTrashRestoreTools, type TrashRestorePort } from '@gugu/core/tools'
import { createConversationReadTool, createConversationSearchTool, type ConversationReadPort, type ConversationSearchPort } from '@gugu/core/tools'
import { createMemorySearchTool, type MemorySearchPort } from '@gugu/core/tools'
import { createKnowledgeReadTool, createKnowledgeWriteTools, type KnowledgeReadPort, type KnowledgeWritePort } from '@gugu/core/tools'
import { createCanvasPlacementTools, createCanvasRelationTools, createCanvasEditTools, createCanvasBatchTool, createCanvasDeleteNoteTool, createCanvasDisconnectTool, createCanvasDeleteTool, type CanvasBatchPort, type CanvasDeleteNotePort, type CanvasDisconnectPort, type CanvasDeletePort, type CanvasEditPort } from '@gugu/core/tools'
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
import { createClientTools, createCanvasReadTools, createWorkspaceUpdateTool, createNoteReadTools, createGetToolSchemaTool, createProjectStageTools, createListEventsTool, createCalendarEventCreateTool, createCalendarEventUpdateTool, createCalendarDeleteTool, createWorkspaceReadTools, createDashboardStatsTool, createProjectMutationTools, createGlobalSearchTool, createUpcomingTool, createListTrashTool, createGetProjectTool, createListProjectsTool, createListScheduledTasksTool, createProjectCreationPort, createProjectTool, createTimeTool, createToolRegistry, createUseSkillTool, createHttpGetTool } from '@gugu/core/tools'
import type { CalendarDeletePort, CalendarEventCreateToolPort, CalendarEventUpdateToolPort, WorkspaceMutationPort, ProjectMutationPort, TrashListPort, ProjectFileOverview, ScheduledTaskListPort, UseSkillPorts } from '@gugu/core/tools'
import type { ProjectCreateRuntime } from '@gugu/core/project-create'
import { agentProjectDispatchKey } from './agent-project-tool.js'

type AuthorizedToolName = 'create_project' | 'list_clients' | 'create_client' | 'update_client' | 'list_projects' | 'get_project' | 'get_current_time' | 'use_skill' | 'list_scheduled_tasks' | 'global_search' | 'get_upcoming' | 'list_trash' | 'list_events' | 'create_event' | 'update_event' | 'delete_event' | 'list_workspaces' | 'get_dashboard_stats' | 'update_project' | 'set_color' | 'archive_project' | 'add_stage' | 'remove_stage' | 'rename_stage' | 'set_stages' | 'update_stage' | 'note_search' | 'note_get' | 'get_tool_schema' | 'canvas_list' | 'canvas_get' | 'canvas_search' | 'canvas_focus_node' | 'update_workspace' | 'canvas_search_placeable' | 'canvas_create' | 'canvas_batch' | 'canvas_delete_note' | 'canvas_disconnect' | 'canvas_delete' | 'list_skills' | 'create_skill' | 'update_skill' | 'canvas_update_node' | 'canvas_remove_node' | 'canvas_update_note' | 'canvas_create_note' | 'canvas_add_node' | 'canvas_update_anchor' | 'canvas_connect' | 'note_delete' | 'note_restore' | 'note_undo'

export interface AgentToolRegistryOptions {
  core: SqlDataRuntime
  /** 没有可信项目创建后端时，不开放创建工具。 */
  projects?: ProjectCreateRuntime
  /** 可信权限服务；模型输出不得决定此权限。 */
  authorize(identity: RunIdentity, name: AuthorizedToolName | 'send_link_buttons' | 'ask_user' | 'restore_file' | 'restore_folder' | 'read_conversation' | 'search_conversations' | 'search_memory' | 'read_knowledge' | 'save_knowledge' | 'update_knowledge'): Promise<boolean>
  /** 历史正文读取必须限定可信 owner；缺少共享读取服务时不开放。 */
  conversations?: ConversationReadPort
  /** 必须同时提供 owner 限定的 RAG 与会话定位能力。 */
  conversationSearch?: ConversationSearchPort
  /** Memory 文件、scope ACL、授权和可选 embedding 均须由可信 Host 完整提供。 */
  memorySearch?: MemorySearchPort
  /** 知识正文由 owner FS 读取，关键词召回必须走正式索引和可信 scope 授权。 */
  knowledge?: KnowledgeReadPort
  /** Markdown 主存储、索引失效和持久重建端口；删除工具仍需确认协议。 */
  knowledgeWrites?: KnowledgeWritePort
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
  /** 日历事件删除需同时提供目标确认和事务内 claim，缺少时不注册。 */
  calendarDelete?: CalendarDeletePort
  /** 创建事件/内联提醒需提供同事务 Core 写入及可信渠道目标解析能力。 */
  calendarCreate?: CalendarEventCreateToolPort
  /** 事件/提醒更新需同时具备 owner 目标解析、CAS 与共享 Core 写能力。 */
  calendarUpdate?: CalendarEventUpdateToolPort
  /** 必须是 Host 提供的固定公网目标且不跟随重定向的读取端口；缺失时不注册。 */
  httpGet?: Parameters<typeof createHttpGetTool>[0]
  trash?: TrashListPort
  /** 文件恢复后端需提供持久防重放和归属校验。 */
  trashRestore?: TrashRestorePort
  canvasPlaceableSearch?: ReturnType<typeof createAgentPlaceableSearch>
  canvasPlacements?: CanvasEditPort
  canvasRelations?: CanvasEditPort
  canvasEdits?: CanvasEditPort
  /** 持久确认及事务内claim未装配时不开放完整批处理工具。 */
  canvasBatch?: CanvasBatchPort
  /** 便签删除须由真实 Host 持久确认及事务内claim；未装配时不注册。 */
  canvasDeleteNote?: CanvasDeleteNotePort
  /** 关系删除须由真实 Host 持久确认及事务内claim；未装配时不注册。 */
  canvasDisconnect?: CanvasDisconnectPort
  /** 画布级联删除须由真实 Host 持久确认及事务内claim；未装配时不注册。 */
  canvasDelete?: CanvasDeletePort
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
      ...(options.knowledge || options.knowledgeWrites ? [{ id:'knowledge', name:'知识', tools:[...(options.knowledge?[createKnowledgeReadTool(options.knowledge)]:[]),...(options.knowledgeWrites?createKnowledgeWriteTools(options.knowledgeWrites):[])] }] : []),
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
      ...(options.calendar || options.calendarCreate || options.calendarUpdate || options.calendarDelete?.confirmation ? [{ id: 'calendar', name: '日历', tools: [
        ...(options.calendar ? [createListEventsTool(options.calendar)] : []),
        ...(options.calendarCreate ? [createCalendarEventCreateTool(options.calendarCreate)] : []),
        ...(options.calendarUpdate ? [createCalendarEventUpdateTool(options.calendarUpdate)] : []),
        ...(options.calendarDelete?.confirmation ? [createCalendarDeleteTool(options.calendarDelete)] : []),
      ] }] : []),
      ...(options.httpGet ? [{ id: 'web', name: '联网读取', tools: [createHttpGetTool(options.httpGet)] }] : []),
      ...(options.workspaces || options.workspaceMutations ? [{ id: 'workspaces', name: '工作区', tools: [
        ...(options.workspaces ? createWorkspaceReadTools(options.workspaces) : []),
        ...(options.workspaceMutations ? [createWorkspaceUpdateTool(options.workspaceMutations)] : []),
      ] }] : []),
      ...(options.canvases || options.canvasPlaceableSearch || options.canvasCreation || options.canvasEdits || options.canvasPlacements || options.canvasRelations || options.canvasBatch?.confirmation || options.canvasDeleteNote?.confirmation || options.canvasDisconnect?.confirmation || options.canvasDelete?.confirmation ? [{id:'canvas',name:'画布',tools:[
        ...(options.canvases ? createCanvasReadTools(options.canvases) : []),
        ...(options.canvasEdits ? createCanvasEditTools(options.canvasEdits) : []),
        ...(options.canvasBatch?.confirmation ? [createCanvasBatchTool(options.canvasBatch)] : []),
        ...(options.canvasDeleteNote?.confirmation ? [createCanvasDeleteNoteTool(options.canvasDeleteNote)] : []),
        ...(options.canvasDisconnect?.confirmation ? [createCanvasDisconnectTool(options.canvasDisconnect)] : []),
        ...(options.canvasDelete?.confirmation ? [createCanvasDeleteTool(options.canvasDelete)] : []),
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
    authorize: (identity, name) => options.authorize(identity, name as AuthorizedToolName | 'send_link_buttons' | 'ask_user' | 'restore_file' | 'restore_folder' | 'read_conversation' | 'search_conversations' | 'search_memory' | 'read_knowledge' | 'save_knowledge' | 'update_knowledge'),
  })
  return registry
}
