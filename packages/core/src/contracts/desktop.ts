export const DESKTOP_CALENDAR_UNDO_CONTEXT = 'desktop-calendar'
import type { DisplayItem } from '../agent/models.js'
import type { ByokCommand, ByokResult, ByokTarget, DesktopAuxiliaryModelCommand, DesktopAuxiliaryModelResult } from '../byok/contracts.js'
import type { RemoteAccountState, RemoteLoginInput } from '../auth/contracts.js'
import type { ImGroupAttentionMode, ImGroupReplyMode } from '../im/group-settings.js'

// 仅共享桌面 DTO 和固定能力名称；不依赖 Electron 或 Node。
export { CORE_SCHEMA_VERSION } from './schema.js'
export const DESKTOP_ARCHIVE_TIMEOUT_MS = 120_000
export const DESKTOP_ARCHIVE_METHODS: readonly string[] = [
  'preferences.exportBusinessArchive', 'preferences.preflightBusinessArchive', 'preferences.applyBusinessArchive',
]
export const MAX_FRAME = 65_536
export const MAX_AGENT_RESPONSE = 4 * 1024 * 1024
export const CHUNKED_AGENT_METHODS = ['agent.sessions.events', 'agent.sessions.history', 'agent.sessions.messages', 'agent.sessions.toolDetails', 'agent.sessions.queue', 'im.inbox.projection', 'im.chart.render'] as const
export const DESKTOP_METHODS = [
  'core.info',
  'im.inbox.admit',
  'im.inbox.attachmentReference',
  'im.inbox.prepare',
  'im.inbox.pendingConnection',
  'im.inbox.recordGroup',
  'im.inbox.groupAttentionHistory',
  'im.inbox.resumePendingAsk',
  'im.inbox.reject',
  'im.inbox.prompt',
  'im.inbox.delivery',
  'im.inbox.projection',
  'im.qq.sequence',
  'im.chart.render',
  'agent.sessions.list',
  'agent.sessions.workspace',
  'agent.sessions.setWorkspace',
  'agent.sessions.goal',
  'agent.sessions.compact',
  'agent.sessions.recoverStartup',
  'agent.sessions.create',
  'agent.sessions.rename',
  'agent.sessions.delete',
  'agent.sessions.messages',
  'agent.sessions.history',
  'agent.sessions.messageLocation',
  'agent.sessions.toolDetails',
  'agent.sessions.events',
  'agent.sessions.cancelRun',
  'agent.sessions.startRun',
  'agent.memory.invalidateEmbedding',
  'agent.memory.resumeReflections',
  'agent.memory.read',
  'agent.greeting.prompt',
  'agent.memory.clear',
  'agent.memory.forget',
  'agent.sessions.respond',
  'agent.sessions.runModel',
  'agent.sessions.append',
  'agent.sessions.queue',
  'agent.attachments.stage',
  'agent.attachments.deleteDraft',
  'agent.attachments.download',
  'agent.attachments.clearDrafts',
  'agent.attachments.forSession',
  'agent.attachments.stage',
  'agent.attachments.deleteDraft',
  'agent.attachments.forSession',
  'skills.list',
  'skills.tools',
  'mcp.list',
  'mcp.config',
  'skills.create',
  'skills.update',
  'skills.delete',
  'mcp.create',
  'mcp.update',
  'mcp.delete',
  'schedules.list',
  'schedules.get',
  'schedules.create',
  'schedules.update',
  'schedules.delete',
  'schedules.claim',
  'schedules.channels',
  'schedules.targets',
  'schedules.groupCatalog',
  'schedules.reminder.deliverIm',
  'schedules.instruction.start',
  'schedules.instruction.result',
  'projects.list',
  'projects.create',
  'projects.rename',
  'projects.board.list',
  'projects.board.get',
  'projects.board.create',
  'projects.board.update',
  'projects.board.delete',
  'projects.board.restore',
  'projects.board.purge',
  'clients.list',
  'clients.create',
  'clients.update',
  'clients.delete',
  'calendar.update',
  'calendar.delete',
  'preferences.desktop.get',
  'preferences.agent',
  'preferences.agentUsage',
  'preferences.dataInventory',
  'preferences.exportBusinessArchive',
  'preferences.preflightBusinessArchive',
  'preferences.applyBusinessArchive',
  'desktop.search',
  'preferences.desktop.update',
  'onboarding.desktop.get',
  'mind.canvases.list',
  'mind.canvases.items.list',
  'mind.canvases.relations.list',
  'mind.canvases.items.add',
  'mind.canvases.items.bring-to-front',
  'mind.canvases.relations.create',
  'mind.canvases.relations.delete',
  'mind.ref.create',
  'mind.canvas-note.location',
  'mind.canvases.create',
  'mind.canvases.update',
  'mind.canvases.delete',
  'mind.canvases.notes.create',
  'mind.canvases.notes.update',
  'mind.canvases.items.update',
  'mind.canvases.items.delete',
  'operations.get',
  'executor.diagnostics',
  'desktop.terminal',
] as const
export const DESKTOP_MUTATIONS: readonly string[] = [
  'im.inbox.resumePendingAsk',
  'agent.attachments.stage',
  'agent.attachments.deleteDraft',
  'agent.sessions.create',
  'agent.sessions.rename',
  'agent.sessions.setWorkspace',
  'agent.sessions.delete',
  'agent.sessions.append',
  'agent.sessions.queue',
  'skills.create',
  'skills.update',
  'skills.delete',
  'mcp.create',
  'mcp.update',
  'mcp.delete',
  'schedules.create',
  'schedules.update',
  'schedules.delete',
  'projects.create',
  'projects.rename',
  'projects.board.create',
  'projects.board.update',
  'projects.board.delete',
  'projects.board.restore',
  'projects.board.purge',
  'clients.create',
  'clients.update',
  'clients.delete',
  'calendar.create',
  'calendar.update',
  'calendar.delete',
  'preferences.desktop.update',
  'preferences.applyBusinessArchive',
  'mind.canvases.create',
  'mind.canvases.update',
  'mind.canvases.delete',
  'mind.notes.create',
  'mind.notes.update',
  'mind.notes.delete',
  'mind.canvases.notes.create',
  'mind.canvases.notes.update',
  'mind.canvases.items.update',
  'mind.canvases.items.delete',
  'mind.canvases.items.add',
  'mind.canvases.items.bring-to-front',
  'mind.canvases.relations.create',
  'mind.canvases.relations.delete',
  'mind.ref.create',
]
export const DESKTOP_CHANNELS = {
  remoteByok: 'gugu:remote-byok',
  remoteAccount: 'gugu:remote-account:status',
  remoteLogin: 'gugu:remote-account:login',
  remoteLogout: 'gugu:remote-account:logout',
  projects: 'gugu:projects:list',
  createProject: 'gugu:projects:create',
  renameProject: 'gugu:projects:rename',
  projectBoard: 'gugu:projects:board:list',
  projectDetails: 'gugu:projects:board:get',
  createBoardProject: 'gugu:projects:board:create',
  updateBoardProject: 'gugu:projects:board:update',
  deleteBoardProject: 'gugu:projects:board:delete',
  restoreBoardProject: 'gugu:projects:board:restore',
  purgeBoardProject: 'gugu:projects:board:purge',
  clients: 'gugu:clients:list',
  createClient: 'gugu:clients:create',
  renameClient: 'gugu:clients:rename',
  deleteClient: 'gugu:clients:delete',
  calendar: 'gugu:calendar:list',
  search: 'gugu:search:query',
  files: 'gugu:files:request',
  startFileDrag: 'gugu:files:start-drag',
  nativeFileDragSource: 'gugu:files:drag-source',
  createDroppedFileReference: 'gugu:files:dropped-reference',
  openDroppedFileReference: 'gugu:files:open-dropped-reference',
  personalSmtp: 'gugu:preferences:personal-smtp',
  mail: 'gugu:mail:request',
  resources: 'gugu:resources:request',
  agentSessions: 'gugu:agent:sessions',
  agentAttachment: 'gugu:agent:attachment',
  agentChatEvent: 'gugu:agent:chat-event',
  agentRunChanged: 'gugu:agent:run-changed',
  agentModel: 'gugu:agent:model',
  auxiliaryModel: 'gugu:agent:auxiliary-model',
  telegramGateway: 'gugu:im:telegram',
  qqPairing: 'gugu:im:qq:pairing',
  feishuPairing: 'gugu:im:feishu:pairing',
  wechatPairing: 'gugu:im:wechat:pairing',
  scheduleTask: 'gugu:schedules:request',
  scheduleChanged: 'gugu:schedules:changed',
  appearance: 'gugu:preferences:appearance:get',
  readLogs: 'gugu:logs:read',
  updateAppearance: 'gugu:preferences:appearance:update',
  agentPreference: 'gugu:preferences:agent',
  agentUsage: 'gugu:preferences:agent-usage',
  dataInventory: 'gugu:preferences:data-inventory',
  exportBusinessArchive: 'gugu:preferences:export-business-archive',
  preflightBusinessArchive: 'gugu:preferences:preflight-business-archive',
  applyBusinessArchive: 'gugu:preferences:apply-business-archive',
  clearAgentMemory: 'gugu:preferences:memory:clear',
  clearAgentAttachments: 'gugu:preferences:attachments:clear-drafts',
  onboarding: 'gugu:onboarding:state:get',
  createCalendarEvent: 'gugu:calendar:create',
  updateCalendarEvent: 'gugu:calendar:update',
  deleteCalendarEvent: 'gugu:calendar:delete',
  canvases: 'gugu:mind:canvases:list',
  createCanvas: 'gugu:mind:canvases:create',
  updateCanvas: 'gugu:mind:canvases:update',
  deleteCanvas: 'gugu:mind:canvases:delete',
  canvasItems: 'gugu:mind:canvases:items:list',
  canvasRelations: 'gugu:mind:canvases:relations:list',
  addCanvasItem: 'gugu:mind:canvases:items:add',
  bringCanvasItemToFront: 'gugu:mind:canvases:items:bring-to-front',
  createCanvasRelation: 'gugu:mind:canvases:relations:create',
  deleteCanvasRelation: 'gugu:mind:canvases:relations:delete',
  createRefNode: 'gugu:mind:ref:create',
  canvasNoteLocation: 'gugu:mind:canvas-note:location',
  createCanvasNote: 'gugu:mind:canvases:notes:create',
  updateCanvasNote: 'gugu:mind:canvases:notes:update',
  updateCanvasItem: 'gugu:mind:canvases:items:update',
  deleteCanvasItem: 'gugu:mind:canvases:items:delete',
  notes: 'gugu:mind:notes:list',
  createNote: 'gugu:mind:notes:create',
  updateNote: 'gugu:mind:notes:update',
  deleteNote: 'gugu:mind:notes:delete',
  receipt: 'gugu:operations:get',
  undoPreview: 'gugu:undo:preview',
  undoApply: 'gugu:undo:apply',
  undoRedo: 'gugu:undo:redo',
  terminal: 'gugu:terminal:request',
  sandboxStatus: 'gugu:sandbox:diagnostics',
} as const
export interface DesktopProject {
  id: number
  name: string
  version: number
}
export type DesktopProjectCollection = 'active' | 'archived' | 'deleted'
export interface DesktopProjectDetails extends DesktopProject {
  client: string | null
  status: string
  startDate: string | null
  deadline: string | null
  color: string
  progress: number
  stages: Record<string, unknown>[]
  currentStage: string | null
  archived: boolean
  priority: string | null
  doneAt: string | null
  updatedAt: string
  deletedAt: string | null
  createdAt: string
}
export interface DesktopProjectPage {
  items: DesktopProjectDetails[]
  nextOffset: number | null
}
export interface DesktopClient {
  id: number
  name: string
}
export interface DesktopCalendarEvent {
  id: number
  title: string
  date: string
  time: string | null
  endTime: string | null
  description: string | null
  version: number
}
export interface DesktopCanvas {
  id: number
  title: string
  projectId: number | null
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
export interface DesktopNote {
  id: number
  title: string | null
  contentMd: string
  color: string | null
  version: number
}
export interface DesktopCanvasItemNode extends DesktopNote {
  kind: string
}
export interface DesktopCanvasItem {
  id: number
  canvasId: number
  nodeId: number
  x: number
  y: number
  w: number | null
  h: number | null
  z: number
  collapsed: boolean
  data: Record<string, unknown>
  refData: { date: string; time: string | null; endTime: string | null; description: string | null } | null
  node: DesktopCanvasItemNode
  createdAt: string
  updatedAt: string
}
export interface SandboxStatus {
  supported: boolean
  methods: string[]
  checkAvailable: boolean
  reason?: string
}
export type DesktopReply<T> =
  | { ok: true; result: T }
  | {
      ok: false
      error: { code: string; message: string; operationId?: string }
    }
export interface DesktopAgentSession { id: number; title: string; updatedAt: string; source?: string; chatType?: string; workspaceName?: string | null; isRunning?: boolean; lastAssistantId?: number; goalActive?: boolean; goalStatus?: 'active' | 'paused' | null }
export interface DesktopAgentMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  files?: DesktopAgentMessageAttachment[]
  references?: DesktopAgentChatReference[]
  clientMessageId?: string
  runId?: string
  runOutcome?: { status: 'failed' | 'interrupted'; runId: string }
  platformUserId?: string
  platformUserName?: string
  toolTimeline?: DisplayItem[]
  assistantTimeline?: DisplayItem[]
  interactions?: Array<{ id: number; run_id: string; [key: string]: unknown }>
}
export interface DesktopAgentAttachment {
  transcript?: string
  attach_id: string
  name: string
  ext: string
  size: number
  kind: string
  mime: string | null
  duration: number | null
  img_width: number | null
  img_height: number | null
  upload: true
}
export type DesktopAgentMessageAttachment = Omit<DesktopAgentAttachment, 'size'> & { size_bytes?: number; size?: number }
export interface DesktopAgentAttachmentDownload {
  name: string
  mime: string
  data: Uint8Array
}
export interface DesktopAgentChatReference { type: string; id: number | string; label: string }
export type DesktopAgentAttachmentCommand =
  | { action: 'upload'; name: string; mime: string | null; voice: boolean; data: Uint8Array }
  | { action: 'deleteDraft'; attachId: string }
  | { action: 'download'; attachId: string }
export interface DesktopAgentHistoryPage {
  session?: Pick<DesktopAgentSession, 'goalActive' | 'goalStatus' | 'chatType' | 'workspaceName'> & { ownerPlatformUserId?: string }
  executionState?: string
  active?: boolean
  messages: DesktopAgentMessage[]
  pagination: { hasMore: boolean; oldestId: number | null }
}
export interface DesktopAgentRunCancellation { ok: true; outcome: 'requested' | 'already_completed' }
export interface DesktopAgentInteractionReply { runId: string; awaitingText: boolean }
export interface DesktopAgentQueueItem { key: number; text: string; modelId?: string; attachments: Record<string, unknown>[]; references: Record<string, unknown>[]; queue_id: string; session_id: number | null; claimed: boolean }
export interface DesktopAgentQueueSnapshot { sessionId: number | null; items: DesktopAgentQueueItem[]; projected: true }
export interface DesktopAgentImportedQueue { queueId: string; items: DesktopAgentQueueItem[]; projected: true }
export interface DesktopAgentEventPage {
  executionState?: string
  runId: string | null
  events: { type: string; [key: string]: unknown }[]
  cursor: number
  status: string
  hasMore: boolean
}
export type DesktopAgentChatEvent =
  | { type: 'session_id'; operationId: string; session_id: number; user_message_id?: number; run_id?: string; client_message_id?: string }
  | { type: 'content'; operationId: string; text: string }
  | { type: 'projected'; operationId: string; event: { type: string; [key: string]: unknown } }


export type DesktopAgentSessionCommand =
  | { action: 'readMemory' }
  | { action: 'greeting'; locale: 'zh-CN' | 'ja-JP' | 'en-US' }
  | { action: 'goal'; id: number; goalAction: 'status' | 'pause' | 'cancel' | 'resume' }
  | { action: 'workspace'; id: number; workspaceAction: 'list' | 'show' | 'bind' | 'unlink'; directoryId?: string; operationId: string }
  | { action: 'forgetMemory'; query: string; revision?: string }
  | { action: 'list' }
  | { action: 'create'; title: string; operationId: string; greeting?: string }
  | { action: 'rename'; id: number; title: string; operationId: string }
  | { action: 'delete'; id: number; operationId: string }
  | { action: 'messages'; id: number }
  | { action: 'messageLocation'; messageId: number }
  | { action: 'history'; id: number; before?: number }
  | { action: 'toolDetails'; id: number; messageId: number; index: number }
  | { action: 'resume'; id: number; runId: string; operationId: string }
  | { action: 'disconnect'; operationId: string }
  | { action: 'cancelRun'; id: number; runId: string }
  | ({ action: 'respond'; id: number; runId: string; promptId: number } &
    ({ operationId: string } & ({ token: string; selectedOptionIds?: string[]; customAnswer?: string } | { text: string } | { secrets: Record<string, string> | null }) | { recover: true }))
  | { action: 'events'; id: number; runId?: string; after?: number; stateOnly?: true }
  | { action: 'cancel'; id: number; operationId: string }
  | { action: 'queue'; operationId?: string; queueAction: 'read'; queueId: string }
  | { action: 'queue'; operationId?: string; queueAction: 'imports' }
  | { action: 'queue'; operationId: string; queueAction: 'replace'; queueId: string; items: Record<string, unknown>[] }
  | { action: 'queue'; operationId: string; queueAction: 'patch'; queueId: string; sessionId: number; items: Record<string, unknown>[]; removedKeys: number[] }
  | { action: 'queue'; operationId?: string; queueAction: 'claim'; queueId: string; sessionId: number; key: number }
  | { action: 'queue'; operationId?: string; queueAction: 'release'; queueId: string; sessionId: number; key: number; claimToken: string }
  | { action: 'send'; stream?: boolean; id: number; text: string; locale?: 'zh-CN' | 'ja-JP' | 'en-US'; modelId?: string; clientMessageId?: string; attachments?: string[]; references?: DesktopAgentChatReference[]; queueClaim?: { key: number; token: string }; operationId: string }

export interface DesktopAgentModelOptions {
  contextTokens?: number
  maxTokens?: number
  thinkingMode?: string
  webSearchEnabled?: boolean
  image?: boolean
  audio?: boolean
  video?: boolean
  localRuntime?: 'llama.cpp' | 'vllm' | 'other'
  ollamaMode?: 'local' | 'cloud'
}
export interface DesktopAgentModel extends DesktopAgentModelOptions { baseUrl: string; model: string; provider: string; apiFormat: string }
export interface DesktopAgentModelEntry extends DesktopAgentModel { id: string }
export interface DesktopAgentModelList { items: DesktopAgentModelEntry[]; defaultId: string | null }
type DesktopAgentModelDraft = DesktopAgentModel & { apiKey: string }
export type DesktopAgentMediaDimension = 'image' | 'audio' | 'video'
export interface DesktopAgentMediaResult { dim: DesktopAgentMediaDimension; supported: boolean | null; status: number; detail: string }
export interface DesktopAgentModelCapabilities {
  default_base_url: string
  default_base_urls: Record<string, string>
  reasoning_modes: readonly string[]
  reasoning_efforts: readonly string[]
  supports_adaptive_thinking: boolean
  generic_thinking_toggle_supported: boolean
}
export type DesktopAgentModelCommand =
  | { action: 'get' | 'list' }
  | { action: 'save'; preset: DesktopAgentModelDraft }
  | { action: 'put'; id: string | null; preset: DesktopAgentModelDraft }
  | { action: 'models'; id?: string | null; preset: DesktopAgentModelDraft }
  | { action: 'set_default' | 'delete'; id: string }
  | { action: 'test'; id?: string | null; preset?: DesktopAgentModelDraft }
  | { action: 'capabilities'; model: DesktopAgentModel }
  | { action: 'probe'; id?: string | null; preset: DesktopAgentModelDraft; dim: DesktopAgentMediaDimension }

export interface DesktopTelegramMessage { id: number; text: string; receivedAt: string }
export interface DesktopTelegramSnapshot {
  configured: boolean
  bound: boolean
  binding?: { code: string; expiresAt: number }
  enabled: boolean
  privateStreamingEnabled?: boolean
  status: 'disabled' | 'connecting' | 'connected' | 'retrying' | 'conflict' | 'cleanup_failed'
  messages: DesktopTelegramMessage[]
  groupChatEnabled?: boolean
  groupReplyMode?: ImGroupReplyMode
  groupAttentionMode?: ImGroupAttentionMode
  groupWebToolsEnabled?: boolean
  groupProviderSearchEnabled?: boolean
  groupHistorySearchEnabled?: boolean
  groupOwnerMemoryEnabled?: boolean
  groupMemoryEnabled?: boolean
  memberMemoryEnabled?: boolean
}
export type DesktopImGroupSettingsPatch = {
  groupChatEnabled?: boolean
  groupReplyMode?: ImGroupReplyMode
  groupAttentionMode?: ImGroupAttentionMode
  groupWebToolsEnabled?: boolean
  groupProviderSearchEnabled?: boolean
  groupHistorySearchEnabled?: boolean
  groupOwnerMemoryEnabled?: boolean
  groupMemoryEnabled?: boolean
  memberMemoryEnabled?: boolean
}
export type DesktopQrPairingCommand =
  | { action: 'start' | 'status' | 'enable' | 'disable' }
  | { action: 'setPrivateStreaming'; enabled: boolean }
  | { action: 'poll'; taskId: string }
  | { action: 'updateGroupSettings'; patch: DesktopImGroupSettingsPatch }

export type DesktopImConnectionState = 'disabled' | 'connecting' | 'running' | 'retrying' | 'cleanup_failed'

export type DesktopQrPairingResult =
  | { configured: boolean; enabled: boolean; bound?: boolean; privateMessageFormat?: 'compat' | 'markdown'; groupMessageFormat?: 'compat' | 'markdown'; privateStreamingEnabled?: boolean; groupChatEnabled?: boolean; groupHistorySearchEnabled?: boolean; groupWebToolsEnabled?: boolean; groupProviderSearchEnabled?: boolean; groupOwnerMemoryEnabled?: boolean; groupMemoryEnabled?: boolean; memberMemoryEnabled?: boolean; groupReplyMode?: ImGroupReplyMode; groupAttentionMode?: ImGroupAttentionMode; detail?: string; connectionState?: DesktopImConnectionState }
  | { task_id: string; scan_url: string }
  | { poll_id: string; scan_url: string }
  | { status: string; reason?: string; bot?: { id: number; name: string } }

export type DesktopTelegramCommand =
  | { action: 'status' | 'enable' | 'disable' | 'bindingCode' }
  | { action: 'setPrivateStreaming'; enabled: boolean }
  | { action: 'save'; input: { token: string } }
  | { action: 'updateGroupSettings'; patch: DesktopImGroupSettingsPatch }

export type DesktopLogKind = 'regular' | 'diagnostic'

export interface DesktopSearchResult {
  total: number
  partial?: boolean
  groups: Array<{
    type: 'project' | 'event' | 'note' | 'canvas_note' | 'file' | 'folder' | 'mcp' | 'scheduled_task'
    label: string
    items: Array<{
      id: number | string
      title: string
      subtitle?: string
      date?: string
      canvas_id?: number
      path_file?: { directoryId: DesktopFileDirectory; directoryName: string; relativePath: string; sandboxPath?: string }
    }>
  }>
}

export interface DesktopBridge {
  search(queries: string[]): Promise<DesktopReply<DesktopSearchResult>>
  readLogs(kind: DesktopLogKind): Promise<DesktopReply<{ lines: string[]; truncated: boolean }>>
  qqPairing(command: DesktopQrPairingCommand | { action: 'bindingCode' | 'unbind' } | { action: 'setPrivateMessageFormat' | 'setGroupMessageFormat'; format: 'compat' | 'markdown' }): Promise<DesktopReply<DesktopQrPairingResult | { code: string; expires_in: number }>>
  feishuPairing(command: DesktopQrPairingCommand): Promise<DesktopReply<DesktopQrPairingResult>>
  wechatPairing(command: DesktopQrPairingCommand): Promise<DesktopReply<DesktopQrPairingResult>>
  telegramGateway(command: DesktopTelegramCommand): Promise<DesktopReply<DesktopTelegramSnapshot>>
  auxiliaryModel(command: DesktopAuxiliaryModelCommand): Promise<DesktopReply<DesktopAuxiliaryModelResult>>
  agentModel(command: DesktopAgentModelCommand): Promise<DesktopReply<DesktopAgentModel | DesktopAgentModelList | DesktopAgentMediaResult | DesktopAgentModelCapabilities | string[] | null>>
  agentSessions(command: DesktopAgentSessionCommand): Promise<DesktopReply<DesktopAgentSession[] | DesktopAgentSession | DesktopAgentMessage[] | DesktopAgentHistoryPage | DesktopAgentEventPage | DesktopAgentRunCancellation | DesktopAgentInteractionReply | DesktopAgentQueueSnapshot | DesktopAgentImportedQueue[] | Record<string, unknown> | boolean | null>>
  agentAttachment?(command: DesktopAgentAttachmentCommand): Promise<DesktopReply<DesktopAgentAttachment | DesktopAgentAttachmentDownload | null>>
  onAgentRunChanged?(callback: (sessionId: number, interactionChanged?: true) => void): () => void
  onAgentChatEvent?(callback: (event: DesktopAgentChatEvent) => void): () => void
  terminal(command: DesktopTerminalCommand): Promise<DesktopReply<DesktopTerminalResult>>
  remoteByok(target: ByokTarget, command: ByokCommand): Promise<DesktopReply<ByokResult>>
  remoteAccount(): Promise<DesktopReply<RemoteAccountState>>
  remoteLogin(input: RemoteLoginInput): Promise<DesktopReply<RemoteAccountState>>
  remoteLogout(): Promise<DesktopReply<RemoteAccountState>>
  files(command: DesktopFileCommand): Promise<DesktopReply<unknown>>
  startFileDrag?(directoryId: DesktopFileDirectory, path: string, preview?: string): Promise<DesktopReply<null>>
  personalSmtp(action: 'get' | 'save' | 'test', input?: Record<string, unknown>): Promise<DesktopReply<import('../preferences/smtp.js').SmtpSettings & { configured: true } | { ok: boolean; message: string } | null>>
  mail(command: import('../mail/contracts.js').MailCommand): Promise<DesktopReply<unknown>>
  resources(command: DesktopResourceCommand): Promise<DesktopReply<unknown>>
  scheduleTask(command: DesktopScheduleCommand): Promise<DesktopReply<DesktopScheduleResult>>
  onScheduleChanged(callback: () => void): () => void
  createDroppedFileReference?(file: File): Promise<DesktopReply<{ type: 'file'; id: string; label: string }>>
  openDroppedFileReference?(id: string): Promise<DesktopReply<null>>
  agentUsage(): Promise<DesktopReply<DesktopAgentUsage>>
  dataInventory(): Promise<DesktopReply<Record<string, number>>>
  preflightBusinessArchive(): Promise<DesktopReply<{ id: string; added: number; skipped: number } | null>>
  applyBusinessArchive(id: string): Promise<DesktopReply<{ added: number; skipped: number }>>
  exportBusinessArchive(): Promise<DesktopReply<null>>
  agentPreference(kind: DesktopAgentPreferenceKind, patch?: DesktopAgentPreferencePatch): Promise<DesktopReply<DesktopAgentPreference>>
  clearAgentMemory(): Promise<DesktopReply<null>>
  clearAgentAttachments(): Promise<DesktopReply<{ deleted: number }>>
  appearance(): Promise<DesktopReply<DesktopAppearancePreferences>>
  updateAppearance(patch: Partial<DesktopAppearancePreferences>): Promise<DesktopReply<DesktopAppearancePreferences>>
  onboarding(): Promise<DesktopReply<DesktopOnboardingState>>
  projects(): Promise<DesktopReply<DesktopProject[]>>
  createProject(name: string): Promise<DesktopReply<DesktopProject>>
  renameProject(id: number, version: number, name: string): Promise<DesktopReply<DesktopProject>>
  projectBoard(collection: DesktopProjectCollection, offset: number): Promise<DesktopReply<DesktopProjectPage>>
  projectDetails(id: number): Promise<DesktopReply<DesktopProjectDetails>>
  createBoardProject(fields: Record<string, unknown>, operationId?: string): Promise<DesktopReply<DesktopProjectDetails>>
  updateBoardProject(id: number, version: number, fields: Record<string, unknown>): Promise<DesktopReply<DesktopProjectDetails>>
  deleteBoardProject(id: number): Promise<DesktopReply<null>>
  purgeBoardProject(id: number): Promise<DesktopReply<null>>
  restoreBoardProject(id: number): Promise<DesktopReply<DesktopProjectDetails>>
  clients(): Promise<DesktopReply<DesktopClient[]>>
  createClient(name: string): Promise<DesktopReply<DesktopClient>>
  renameClient(id: number, name: string): Promise<DesktopReply<DesktopClient>>
  deleteClient(id: number): Promise<DesktopReply<null>>
  calendar(): Promise<DesktopReply<DesktopCalendarEvent[]>>
  createCalendarEvent(title: string, date: string, details?: { time?: string | null; endTime?: string | null; description?: string | null }): Promise<DesktopReply<DesktopCalendarEvent>>
  updateCalendarEvent(id: number, body: { version: number; title?: string; date?: string; time?: string | null; endTime?: string | null; description?: string | null }): Promise<DesktopReply<DesktopCalendarEvent>>
  deleteCalendarEvent(id: number, version: number): Promise<DesktopReply<null>>
  canvases(): Promise<DesktopReply<DesktopCanvas[]>>
  createCanvas(title: string): Promise<DesktopReply<DesktopCanvas>>
  updateCanvas(id: number, body: { title?: string; data?: Record<string, unknown> }): Promise<DesktopReply<DesktopCanvas>>
  deleteCanvas(id: number): Promise<DesktopReply<null>>
  canvasItems(canvasId: number): Promise<DesktopReply<DesktopCanvasItem[]>>
  canvasRelations(canvasId: number): Promise<DesktopReply<Array<{ id: number; canvasId: number | null; srcNodeId: number; dstNodeId: number; relType: string; origin: string; status: string; createdAt: string; updatedAt: string }>>>
  addCanvasItem(canvasId: number, body: ({ nodeId: number } | { fileRefId: string }) & { x?: number; y?: number; w?: number | null; h?: number | null; z?: number; collapsed?: boolean; data?: Record<string, unknown> }): Promise<DesktopReply<DesktopCanvasItem>>
  bringCanvasItemToFront(canvasId: number, id: number, body: { x: number; y: number }): Promise<DesktopReply<DesktopCanvasItem>>
  createCanvasRelation(body: { canvasId: number; srcNodeId: number; dstNodeId: number; allowParallel?: boolean }): Promise<DesktopReply<unknown>>
  deleteCanvasRelation(canvasId: number, id: number): Promise<DesktopReply<null>>
  createRefNode(refType: 'project' | 'file' | 'event', refId: number): Promise<DesktopReply<DesktopNote>>
  canvasNoteLocation(nodeId: number): Promise<DesktopReply<{ canvasId: number } | null>>
  createCanvasNote(canvasId: number, body: { title?: string; contentMd?: string; color?: string | null; x?: number; y?: number; w?: number | null; h?: number | null; z?: number }): Promise<DesktopReply<DesktopCanvasItem>>
  updateCanvasNote(id: number, fields: { version: number; contentMd?: string; title?: string | null; color?: string | null }): Promise<DesktopReply<DesktopNote>>
  updateCanvasItem(canvasId: number, id: number, body: { x?: number; y?: number; w?: number | null; h?: number | null; z?: number; collapsed?: boolean; data?: Record<string, unknown> }): Promise<DesktopReply<DesktopCanvasItem>>
  deleteCanvasItem(canvasId: number, id: number): Promise<DesktopReply<null>>
  notes(): Promise<DesktopReply<DesktopNote[]>>
  createNote(contentMd: string, color?: string): Promise<DesktopReply<DesktopNote>>
  updateNote(id: number, fields: { version: number; contentMd?: string; title?: string | null; color?: string | null }): Promise<DesktopReply<DesktopNote>>
  deleteNote(id: number): Promise<DesktopReply<null>>
  receipt(operationId: string): Promise<DesktopReply<unknown>>
  undoPreview(contextId: string): Promise<DesktopReply<unknown>>
  undoApply(contextId: string, undoId: string, operationId: string): Promise<DesktopReply<unknown>>
  undoRedo(contextId: string, undoId: string, operationId: string): Promise<DesktopReply<unknown>>
  sandboxStatus(): Promise<DesktopReply<SandboxStatus>>
}
export type DesktopScheduledTask = ReturnType<typeof import('../scheduled-tasks/task-list.js').projectScheduledTaskForWeb>
export type DesktopScheduleCommand =
  | { action: 'channels' }
  | { action: 'targets'; platform: string }
  | { action: 'list'; before?: number; eventId?: number }
  | { action: 'create'; fields: Record<string, unknown>; eventId?: number }
  | { action: 'update'; id: number; fields: Record<string, unknown>; eventId?: number }
  | { action: 'delete' | 'run'; id: number; eventId?: number }
export type DesktopScheduleResult = { groups: { chat_id: string; title: string }[]; private_available: boolean } | { channels: string[] } | { tasks: DesktopScheduledTask[]; nextBefore: number | null } | DesktopScheduledTask | { msg: string } | null

export interface DesktopAgentUsage {
  labels: string[]
  tokens_in: number[]
  tokens_out: number[]
  cache_read: number[]
  cache_write: number[]
}

export type DesktopAgentPreferenceKind = 'personality' | 'group-personality' | 'reply-style'
export type DesktopAgentPreferencePatch = { content?: string | null; enabled?: boolean }
export type DesktopAgentPreference = { content: string | null; enabled: boolean; revision: number }

export interface DesktopAppearancePreferences {
  locale?: 'zh-CN' | 'ja-JP' | 'en-US' | null
  defaultView?: 'projects' | 'calendar' | 'files' | 'mind'
  calendarWeekStart?: 'monday' | 'sunday'
  calendarDoneMode?: 'done' | 'deadline'
  projectSort?: 'default' | 'name' | 'deadline'
  customReplyStyle?: string | null
  customReplyStyleEnabled?: boolean
  toolInjectionMode?: 'description' | 'full'
  decisionGuardEnabled?: boolean
  timezone?: string | null
  imToolDisplayMode?: 'off' | 'all' | 'slow_only'
  showIntermediateReplies?: boolean
  fileOpenPreference?: 'preview' | 'system'
  useSystemProxy?: boolean
  keepGatewayOnline?: boolean
  automaticModeEnabled?: boolean
  theme: 'light' | 'dark' | 'system'
  themeFamily: 'glass' | 'mono'
  palette: 'cafe' | 'neutral' | 'red' | 'blue' | 'green'
}
export interface DesktopOnboardingState {
  should_show: boolean
  guide: {
    enabled: boolean
    current_step: string
    completed_steps: string[]
    dismissed: boolean
    completed_at: string | null
    should_show: boolean
  }
  seed: Record<string, unknown>
}

export type DesktopResourceCommand =
  | { domain: 'citation'; action: 'site-name'; url: string }
  | { domain: 'skills'; action: 'list' | 'tools'; offset?: number }
  | { domain: 'mcp'; action: 'list' }
  | { domain: 'mcp'; action: 'config' | 'test'; id: string }
  | { domain: 'skills' | 'mcp'; action: 'create'; fields: Record<string, unknown> }
  | { domain: 'skills' | 'mcp'; action: 'update'; id: string; fields: Record<string, unknown> }
  | { domain: 'skills' | 'mcp'; action: 'delete'; id: string }

export type DesktopFileDirectory = 'personal' | `desktop:${string}` | `project:${number}`
export type DesktopFileWorkspace = { id: DesktopFileDirectory; name: string }

export type DesktopFileCommand =
  | ({ directoryId?: DesktopFileDirectory } & (
      | { action: 'list' | 'reference' | 'mkdir' | 'trash' | 'reveal'; path: string }
      | { action: 'copy' | 'move'; path: string; destination: string }
      | { action: 'upload'; path: string; data: Uint8Array; overwrite: boolean; identity?: string }
      | { action: 'download' | 'open'; path: string; identity?: string }
      | { action: 'search'; query: string }
    ))
  | { action: 'workspace-list' | 'workspace-add' }
  | { action: 'workspace-relink' | 'workspace-remove'; directoryId: DesktopFileDirectory }
  | { action: 'workspace-rename'; directoryId: DesktopFileDirectory; name: string }

export type DesktopTerminalAction =
  | { action: 'open' | 'resize'; cols: number; rows: number }
  | { action: 'input'; data: string }
  | { action: 'output' | 'close' }

export type DesktopTerminalCommand = DesktopTerminalAction & { terminalId: string }

export type DesktopTerminalResult = { output: string; exited: boolean }
