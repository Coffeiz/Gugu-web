/**
 * 旧 API 兼容入口。新调用方按领域从 `@/api/*` 导入。
 */
import type { components } from '@/types/api'
import { BASE_URL, CLIENT_ID, UNDO_CONTEXT_ID, del, get, getCookieValue, getCsrfHeaders, patch, post, put, request, upload, uploadWithProgress } from '@/api/client'
import type { RequestMeta } from '@/api/client'
import { getLocale, i18n, type SupportedLocale } from '@/i18n'
import { isUnauthorizedResponse } from '@/services/authSession'

export { CLIENT_ID, UNDO_CONTEXT_ID, getCookieValue, getCsrfHeaders, uploadWithProgress }
export type { RequestMeta }
export { authApi } from '@/api/auth'
export { eventsApi } from '@/api/calendar'

// 后端 Pydantic 模型（由 OpenAPI 生成，见 npm run gen:types）。高频实体直接复用，前后端对齐。
type Schemas = components['schemas']

export interface FileSummaryResponse {
  recentFiles: Schemas['FileResponse'][]
}

export interface SiteConfig {
  icpNumber: string
  icpUrl: string
  passwordResetEnabled: boolean
  registrationVerificationEnabled: boolean
}

export async function fetchSiteConfig(): Promise<SiteConfig> {
  const response = await fetch(`${BASE_URL}/site-config`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<SiteConfig>
}

export interface UndoPreview {
  available: boolean
  redo_available: boolean
  undo: { operation_id: string; summary: string; resource: string; action: string; target_count: number } | null
  redo: { operation_id: string; summary: string; resource: string; action: string; target_count: number } | null
}

export const undoApi = {
  preview: () => get<UndoPreview>(`/undo/preview?context_id=${encodeURIComponent(UNDO_CONTEXT_ID)}`),
  undo: (operationId: string) => post(`/undo`, { operation_id: operationId, context_id: UNDO_CONTEXT_ID }),
  redo: (operationId: string) => post(`/undo/redo`, { operation_id: operationId, context_id: UNDO_CONTEXT_ID }),
}

export interface DataExportJob {
  id: string
  status: 'queued' | 'running' | 'canceling' | 'ready' | 'failed' | 'canceled' | string
  stage: string | null
  progress_current: number
  progress_total: number | null
  error_code: string | null
  artifact_size: number | null
  created_at: string | null
  expires_at: string | null
  download_available: boolean
}

export interface DataImportPreview {
  format_version: string
  origin_id: string
  export_id: string
  created_at: string
  complete: boolean
  record_count: number
  expanded_bytes: number
  categories: Record<string, { included: boolean; records: number; bytes: number }>
  incremental?: { add: Record<string, number>; skip: Record<string, number>; add_total: number; skip_total: number }
  memory?: { add: Record<string, number>; skip: Record<string, number>; add_total: number; skip_total: number }
  replace?: { current: Record<string, number>; incoming: Record<string, number> }
  conflicts?: { total: number; items: Array<{ source_type: string; portable_id: string; fields: string[]; kind: string }> }
  compatibility?: { mind_refs_as_notes?: number }
}

export interface DataImportJob {
  id: string
  status: string
  stage: string | null
  mode: string
  progress_current: number
  progress_total: number | null
  error_code: string | null
  preview: DataImportPreview | null
  created_at: string | null
  expires_at: string | null
  import_token?: string
  rollback_expires_at?: string | null
}

export const dataPortabilityApi = {
  preview: () => get<{ categories: Record<string, { records: number; bytes: number }>; format_version: string }>('/data-portability/export/preview'),
  listExports: () => get<DataExportJob[]>('/data-portability/exports'),
  createExport: (categories: string[], idempotencyKey: string) => post<DataExportJob>('/data-portability/exports', { categories, idempotency_key: idempotencyKey }),
  getExport: (jobId: string) => get<DataExportJob>(`/data-portability/exports/${encodeURIComponent(jobId)}`),
  cancelExport: (jobId: string) => post<DataExportJob>(`/data-portability/exports/${encodeURIComponent(jobId)}/cancel`),
  deleteExport: (jobId: string) => del<void>(`/data-portability/exports/${encodeURIComponent(jobId)}`),
  createBrowserDownloadTicket: (jobId: string) =>
    post<{ url: string }>(`/data-portability/exports/${encodeURIComponent(jobId)}/download-ticket`),
  async preflightImport(file: File): Promise<DataImportJob> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/zip',
      'X-Client-Id': CLIENT_ID,
      ...getCsrfHeaders(),
      'X-Undo-Context-ID': UNDO_CONTEXT_ID,
    }
    const response = await fetch(`${BASE_URL}/data-portability/imports/preflight`, {
      method: 'POST', body: file, headers, credentials: 'include', cache: 'no-store',
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      const detail = typeof body.detail === 'string' ? body.detail : i18n.global.t('errors.http', { status: response.status })
      throw new Error(detail)
    }
    return response.json() as Promise<DataImportJob>
  },
  getImport: (jobId: string) => get<DataImportJob>(`/data-portability/imports/${encodeURIComponent(jobId)}`),
  listImports: () => get<DataImportJob[]>('/data-portability/imports'),
  deleteImport: (jobId: string) => del<void>(`/data-portability/imports/${encodeURIComponent(jobId)}`),
  resumeImport: (jobId: string) => post<DataImportJob>(`/data-portability/imports/${encodeURIComponent(jobId)}/resume`),
  applyImport: (jobId: string, mode: 'incremental' | 'replace', importToken: string, idempotencyKey: string) =>
    post<DataImportJob>(`/data-portability/imports/${encodeURIComponent(jobId)}/apply`, {
      mode, import_token: importToken, idempotency_key: idempotencyKey,
    }),
  cancelImport: (jobId: string) => post<DataImportJob>(`/data-portability/imports/${encodeURIComponent(jobId)}/cancel`),
  rollbackImport: (jobId: string, idempotencyKey: string) =>
    post<DataImportJob>(`/data-portability/imports/${encodeURIComponent(jobId)}/rollback`, { idempotency_key: idempotencyKey }),
  recoverImport: (jobId: string) => post<DataImportJob>(`/data-portability/imports/${encodeURIComponent(jobId)}/recover`),
  async downloadExport(jobId: string): Promise<Response> {
    const headers: Record<string, string> = {}
    const response = await fetch(`${BASE_URL}/data-portability/exports/${encodeURIComponent(jobId)}/download`, {
      headers, credentials: 'include', cache: 'no-store',
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      const detail = typeof body.detail === 'string' ? body.detail : i18n.global.t('errors.http', { status: response.status })
      throw new Error(detail)
    }
    return response
  },
}

// ── ScheduledTasks（定时任务）─────────────────────────────────────────────────
export type ScheduledTaskKind = 'cron' | 'interval' | 'once'
export type ScheduledTaskMode = 'reminder' | 'instruction'
export interface ScheduledTaskInput {
  execution_mode?: ScheduledTaskMode
  name: string
  schedule_kind?: 'cron' | 'interval' | 'once'
  cron?: string | null
  interval_minutes?: number | null
  start_at?: string | null
  end_at?: string | null
  payload?: string
  channels?: string[]
  enabled?: boolean
  qq_delivery?: { mode: 'private' } | { mode: 'group'; chat_id: string } | null
  im_delivery?: Partial<Record<'qq' | 'feishu' | 'telegram', { mode: 'private' } | { mode: 'group'; chat_id: string }>>
  event_id?: number | null
  authorized_tools?: string[]
  email_attachment_file_paths?: string[]
  workspace_id?: number | null
}
export interface ScheduledTaskResponse extends Omit<ScheduledTaskInput, 'schedule_kind'> {
  id: number
  schedule_kind: ScheduledTaskKind
  cron: string
  payload: string
  channels: string[]
  enabled: boolean
  schedule_status?: 'active' | 'disabled' | 'ended'
  last_run_at?: string | null
  last_run_failed?: boolean
  delivery_targets?: unknown
  authorized_tools: string[]
  email_attachment_file_paths: string[]
  filesystem_authorized: boolean
}

export const scheduledTasksApi = {
  pendingWebNotifications: () => get<{ pending: boolean }>('/scheduled-tasks/pending-web-notifications'),
  list:         ()                  => get<{ tasks: ScheduledTaskResponse[] }>('/scheduled-tasks'),
  listQqTargets: ()                 => get<{ groups: { chat_id: string; title: string }[] }>('/scheduled-tasks/qq-targets'),
  listDeliveryTargets: (platform: 'qq' | 'feishu' | 'telegram') => get<{ private_available: boolean; groups: { chat_id: string; title: string }[] }>(`/scheduled-tasks/delivery-targets/${platform}`),
  listForEvent: (eventId: number)   => get<{ tasks: ScheduledTaskResponse[] }>(`/scheduled-tasks?event_id=${eventId}`),   // 某日历活动绑定的提醒
  create:       (data: Partial<ScheduledTaskInput>)         => post<ScheduledTaskResponse>('/scheduled-tasks', data),
  update:       (id: number, data: Partial<ScheduledTaskInput>, meta?: RequestMeta) => patch<ScheduledTaskResponse>(`/scheduled-tasks/${id}`, data, meta),
  updateForEvent: (eventId: number, id: number, data: Partial<ScheduledTaskInput>) =>
    patch<ScheduledTaskResponse>(`/scheduled-tasks/${id}?event_id=${eventId}`, data),
  delete:       (id: number)        => del(`/scheduled-tasks/${id}`),
  run:          (id: number)        => post(`/scheduled-tasks/${id}/run`),
  requestFilesystemAuthorization: (id: number) => post<Record<string, any>>(`/scheduled-tasks/${id}/filesystem-authorization/request`),
  confirmFilesystemAuthorization: (id: number, confirmCode: string) => post(`/scheduled-tasks/${id}/filesystem-authorization`, { confirm_code: confirmCode }),
  revokeFilesystemAuthorization: (id: number) => del(`/scheduled-tasks/${id}/filesystem-authorization`),
  testNotify:   (data: Partial<Schemas['TestNotify']>) => post('/scheduled-tasks/test-notify', data),   // 测试提醒渠道（不建任务）
}

// ── 用户 BYOK ────────────────────────────────────────────────────────────────
export const byokApi = {
  list: () => get<{ enabled: boolean; status?: string; items: any[] }>('/byok'),
  capabilities: (data: { provider: string; api_format?: string; base_url?: string; model?: string; ollama_api_mode?: string; ollama_mode?: string; local_runtime?: string }) => post<Record<string, any>>('/byok/capabilities', data),
  create: (data: any) => post('/byok', data),
  update: (id: number, data: any) => patch(`/byok/${id}`, data),
  remove: (id: number) => del(`/byok/${id}`),
  test: (id: number) => post<{ ok: boolean; status: string; message: string }>(`/byok/${id}/test`, {}),
  testPreview: (data: any) => post<{ ok: boolean; status: string; message: string }>('/byok/test-preview', data),
  modelsPreview: (data: any) => post<{ models: string[] }>('/byok/models-preview', data),
  mediaCapabilityProbe: (data: any) => post<{ dim: string; supported: boolean | null; status: number; detail: string }>('/byok/media-capability-probe', data),
  rebuildVectors: () => post<{ ok: boolean; message: string; status?: { status: string } }>('/byok/embedding-rebuild', {}),
  rebuildVectorsStatus: () => get<{ status: string; message?: string }>('/byok/embedding-rebuild/status'),
}

export interface McpServerItem {
  id: string
  name: string
  scope: string
  transport: string
  endpoint: string
  command: string
  credential_slots?: Array<{
    id: string
    label: string
    target: 'header' | 'query'
    name: string
    prefix?: string
  }>
  // 编辑视图明文回显的槽位值（owner-only；落库仍为信封密文）
  credential_values?: Record<string, string>
  credential_state?: { configured: boolean; slot_ids: string[] }
  has_credentials: boolean
  enabled: boolean
  confirm_mode: 'auto' | 'confirm_all'
  timeout_seconds: number
  tool_allowlist: string[]
  state: string
  loaded_tool_count: number
  loaded_tool_names?: string[]
}

export const mcpApi = {
  status: () => get<{ enabled: boolean }>('/mcp/status'),
  list: () => get<{ enabled: boolean; max_servers: number; items: McpServerItem[] }>('/mcp/servers'),
  create: (data: Record<string, unknown>) => post<McpServerItem>('/mcp/servers', data),
  update: (id: string, data: Record<string, unknown>) => patch<McpServerItem>(`/mcp/servers/${encodeURIComponent(id)}`, data),
  remove: (id: string) => del(`/mcp/servers/${encodeURIComponent(id)}`),
  test: (id: string) => post<{ ok: boolean; error?: string; tool_count?: number; tools?: string[] }>(`/mcp/servers/${encodeURIComponent(id)}/test_connection`, {}),
  loadStatus: (id: string) => post<{ ok: boolean; state: string; tool_count: number; tool_names?: string[]; error?: string | null }>(`/mcp/servers/${encodeURIComponent(id)}/load_status`, {}),
  reconnect: (id: string) => post<{ ok: boolean; state: string; tool_count: number; total_loaded: number; tool_names?: string[]; error?: string }>(`/mcp/servers/${encodeURIComponent(id)}/reconnect`, {}),
  tools: (id: string) => get(`/mcp/servers/${encodeURIComponent(id)}/tools`),
}

// ── Files ─────────────────────────────────────────────────────────────────────
function filePathUrl(resource: string, path: string) {
  return `/files/by-path${resource ? `/${resource}` : ''}?${new URLSearchParams({ path })}`
}

export const filesApi = {
  libraryCounts: () => get<{
    personalFileCount: number; personalFolderCount: number
    projectFileCount: number; projectFolderCount: number
    trashFileCount: number; trashFolderCount: number
  }>('/files/library-counts'),
  location: (path: string) => get<{
    file: Schemas['FileResponse']
    pathFile: PathFileRef
  }>(filePathUrl('location', path)),
  summary: (recentLimit = 12) => get<FileSummaryResponse>(`/files/summary?recent_limit=${recentLimit}`),
  get:     (path: string) => get<Schemas['FileResponse']>(filePathUrl('', path)),
  storage: ()         => get('/files/storage'),
  update: (path: string, data: Schemas['FileUpdate'] & { workspaceDirectoryId?: number | null }, meta?: RequestMeta) => patch<Schemas['FileResponse']>(filePathUrl('', path), data, meta),
  saveContent: (path: string, content: string, version: number) => put<Schemas['FileResponse']>(filePathUrl('content', path), { content, version }),
  delete:      (path: string, meta?: RequestMeta)   => del(filePathUrl('', path), meta),
  batchDelete: (paths: string[], meta?: RequestMeta)  => post('/files/by-path/batch-delete', { paths }, meta),
  copy: (path: string, body: Schemas['FileCopyBody'] & { workspaceDirectoryId?: number | null }) => post<Schemas['FileResponse']>(filePathUrl('copy', path), body),
  // 返回单文件信息和短时效签名 URL，供预览入口避免加载整个文件库。
  getStreamUrl: (path: string) => get<{ file: Schemas['FileResponse']; url: string }>(filePathUrl('stream-url', path)),
  xlsxPreview: (path: string) => get<{
    version: number
    sheets: Array<{
      images: Record<string, Array<{ id: number; width?: number; height?: number }>>
      data: {
        name?: string
        cells?: Record<string, string>
        merges?: Array<{ s: number; c: number; e: number; d: number }>
        rowHeights?: Record<string, number>
        colWidths?: Record<string, number>
        rows?: number
        cols?: number
      }
    }>
  }>(filePathUrl('xlsx-preview', path)),
  xlsxPreviewImage: async (path: string, imageId: number, version: number) => {
    const res = await fetch(`${BASE_URL}/files/by-path/xlsx-preview-image/${imageId}?${new URLSearchParams({ path, v: String(version) })}`, {
      credentials: 'include',
      headers: getCsrfHeaders(),
    })
    if (isUnauthorizedResponse(res)) throw new Error(i18n.global.t('errors.loginRequired'))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.blob()
  },
  download: async (path: string, filename: string) => {
    const res = await fetch(`${BASE_URL}${filePathUrl('download', path)}`, {
      credentials: 'include',
      headers: getCsrfHeaders(),
    })
    if (isUnauthorizedResponse(res)) throw new Error(i18n.global.t('errors.loginRequired'))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  },
}

// ── 咕咕 Skills ─────────────────────────────────────────────────────────────
export interface UserSkillItem {
  id: string
  name: string
  description_short: string
  description_long: string | null
  category: string
  related_tools: string[]
  body: string
  source: string
  managed_by: 'user' | 'assistant'
  enabled: boolean
  content_digest: string
  created_at: string | null
  updated_at: string | null
}

export interface UserSkillWrite {
  name: string
  description_short: string
  description_long?: string | null
  category: string
  related_tools: string[]
  body: string
  enabled?: boolean
}

export interface SkillToolItem {
  name: string
  description_short: string
  category: string
  enabled: boolean
}

export const userSkillsApi = {
  list: () => get<{ skills: UserSkillItem[] }>('/skills?include_tools=false'),
  tools: () => get<{ tools: SkillToolItem[] }>('/skills/tools'),
  create: (data: UserSkillWrite) => post<UserSkillItem>('/skills', data),
  update: (skillId: string, data: Partial<UserSkillWrite>) => patch<UserSkillItem>(`/skills/${encodeURIComponent(skillId)}`, data),
  delete: (skillId: string) => del(`/skills/${encodeURIComponent(skillId)}`),
}

// ── Mind（思维面板 · 记录）─────────────────────────────────────────────────────
// 类型手写而非取自 Schemas：生成的 src/types/api.ts 要跑起后端才能刷新（npm run gen:types），
// 等下次刷新后可以换成 Schemas['MindNodeResponse'] 等。
export interface MindNote {
  id: number
  kind: string
  title: string | null
  contentMd: string
  color: string | null
  capturedAt: string      // 面向用户的「发生/记录时间」，时间流按它排（不是 createdAt）
  version: number         // 乐观锁：改的时候必须回传，版本对不上后端给 409
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
  refType?: 'project' | 'file' | 'event' | null
  refId?: number | null
  /** 引用对象创建时缓存的极简快照，被引用对象删除后仍能显示这些字段；只在创建那一刻
   *  拍照，之后原对象改这些字段不会回填。字段按 refType 各不相同：
   *  project → client/status/startDate/deadline/doneAt；file → ext；event → date/time/endTime。 */
  refSnapshot?: {
    client?: string | null; status?: string | null; startDate?: string | null; deadline?: string | null; doneAt?: string | null
    ext?: string | null
    fileReferenceId?: string
    date?: string | null; time?: string | null; endTime?: string | null; description?: string | null
  } | null
}
export interface MindNoteCreate {
  contentMd?: string
  title?: string | null
  color?: string | null
  capturedAt?: string     // 不传取当前；补录旧想法时可写成过去
}
export interface MindNoteUpdate {
  contentMd?: string
  title?: string | null
  color?: string | null
  capturedAt?: string
  version: number
}
/** `[[` 补全候选：type+id 是写进正文的稳定锚点，label 只作展示 */
export interface MindRefSuggestItem {
  type: 'project' | 'file' | 'folder' | 'event' | 'canvas_note' | 'conversation' | 'skill' | 'mcp' | 'scheduled_task'
  // mcp 引用的 id 是 UUID 字符串（user_mcp_servers 主键），其余是 int 自增
  id: number | string
  label: string
  subtitle?: string | null
}

export interface MindCanvas {
  id: number
  title: string
  projectId: number | null
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
export interface MindCanvasItem {
  id: number
  // 仅前端使用：乐观插入画布时保持 Vue key 和目标 DOM 稳定，服务端不会返回或持久化该字段。
  clientKey?: string
  canvasId: number
  nodeId: number
  x: number
  y: number
  w: number | null
  h: number | null
  z: number
  collapsed: boolean
  data: Record<string, unknown>
  /** 引用对象的首屏展示快照；当前活动卡包含日期、时间和描述。 */
  refData?: { date?: string; time?: string | null; endTime?: string | null; description?: string | null } | null
  node: MindNote
  createdAt: string
  updatedAt: string
}
export interface MindRelation {
  id: number
  canvasId: number | null
  srcNodeId: number
  dstNodeId: number
  relType: 'related'
  origin: 'user' | 'gugu'
  status: 'confirmed' | 'suggested'
  createdAt: string
  updatedAt: string
}
export interface MindCanvasNoteCreate {
  title?: string
  contentMd?: string
  color?: string | null
  x?: number
  y?: number
  w?: number | null
  h?: number | null
  z?: number
}

// ── Clients ────────────────────────────────────────────────────────────────────
export const clientsApi = {
  list:   ()                            => get<Schemas['ClientResponse'][]>('/clients'),
  create: (data: Schemas['ClientCreate']) => post<Schemas['ClientResponse']>('/clients', data),
  delete: (id: number)                  => del(`/clients/${id}`),
}

export const preferencesApi = {
  get:    ()                                  => get<Schemas['PreferencesResponse']>('/preferences'),
  update: (data: Schemas['PreferencesUpdate']) => request<Schemas['PreferencesResponse']>('PATCH', '/preferences', data),
  uploadPersonality: (file: File) => { const form = new FormData(); form.append('file', file); return upload<Schemas['PreferencesResponse']>('/preferences/personality/upload', form) },
  uploadGroupPersonality: (file: File) => { const form = new FormData(); form.append('file', file); return upload<Schemas['PreferencesResponse']>('/preferences/group-personality/upload', form) },
  uploadReplyStyle: (file: File) => { const form = new FormData(); form.append('file', file); return upload<Schemas['PreferencesResponse']>('/preferences/reply-style/upload', form) },
  updateReplyStyle: (content: string | null) => request<Schemas['PreferencesResponse']>('PATCH', '/preferences/reply-style', { content }),
  getSmtp: () => get<{ host: string; port: number; user: string; fromAddr: string; useSsl: boolean; enabled: boolean; configured: boolean } | null>('/preferences/smtp'),
  saveSmtp: (data: Record<string, unknown>) => request<{ host: string; port: number; user: string; fromAddr: string; useSsl: boolean; enabled: boolean; configured: boolean }>('PUT', '/preferences/smtp', data),
  testSmtp: (data: Record<string, unknown>) => post<{ ok: boolean; message: string }>('/preferences/smtp/test', data),
  previewEmail: (data: Record<string, unknown>) => post<{ html: string }>('/preferences/smtp/preview', data),
}

export const workspacesApi = {
  status: () => get<{ globalEnabled: boolean; sandboxEnabled: boolean; systemGlobalEnabled: boolean; userEnabled: boolean; userSystemEnabled: boolean; dangerousGlobalEnabled: boolean; userDangerousEnabled: boolean; automaticModeGlobalEnabled: boolean; userAutomaticModeEnabled: boolean; filesystemAuthorizationEnabled: boolean; workspaceSupported: boolean; storageBackend: 'local' | 'oss'; terminalMode: 'auto' | 'pty_disabled' | 'entry_disabled'; terminalEntryEnabled: boolean; ptyEnabled: boolean; items: unknown[] }>('/workspaces'),
  create: (data: { name: string; kind: 'project' | 'directory'; projectId?: number; directoryId?: number }) => post('/workspaces', data),
  update: (id: number, data: { name?: string; enabled?: boolean }) => request('PATCH', `/workspaces/${id}`, data),
  delete: (id: number) => del(`/workspaces/${id}`),
  current: (sessionId: number) => get(`/workspaces/session/${sessionId}`),
  bind: (workspaceId: number, sessionId: number) => post(`/workspaces/${workspaceId}/bind/${sessionId}`),
  unbind: (sessionId: number) => del(`/workspaces/binding/${sessionId}`),
}

export interface WorkspaceDirectory {
  id: number
  name: string
  directoryName: string
  isDefault: boolean
  isSystem: boolean
  fileCount: number
  folderCount: number
  boundSessionCount: number
  boundTaskCount: number
}

interface WorkspaceDirectoryPreviewWire {
  id: number
  name: string
  directory_name: string
  is_default: boolean
  is_system: boolean
  file_count: number
  folder_count: number
  bound_session_count: number
  bound_task_count: number
}

function workspaceDirectoryPreviewResponse(row: WorkspaceDirectoryPreviewWire): WorkspaceDirectory {
  return {
    id: row.id,
    name: row.name,
    directoryName: row.directory_name,
    isDefault: row.is_default,
    isSystem: row.is_system,
    fileCount: row.file_count,
    folderCount: row.folder_count,
    boundSessionCount: row.bound_session_count,
    boundTaskCount: row.bound_task_count,
  }
}

export interface PathFileEntry {
  name: string
  kind: 'directory' | 'file'
  relativePath: string
  size: number
  mimeType: string | null
  fileCount?: number
  folderCount?: number
}

export type PathDirectory = number | 'personal' | `desktop:${string}` | `project:${number}`

export interface PathFileRef {
  identity?: string
  directoryId: PathDirectory
  relativePath: string
}

function pathFilePrefix(directory: PathDirectory) {
  if (typeof directory === 'number') return `/workspace-directories/${directory}`
  return directory === 'personal' ? '/files/personal' : `/files/projects/${directory.slice('project:'.length)}`
}

function pathFileEndpoint(file: PathFileRef, resource: string) {
  return `${pathFilePrefix(file.directoryId)}/${resource}?${new URLSearchParams({ path: file.relativePath, ...(file.identity ? { identity: file.identity } : {}) })}`
}

function pathContentUrl(file: PathFileRef, download = false) {
  return `${BASE_URL}${pathFileEndpoint(file, 'content')}${download ? '&download=1' : ''}`
}

export function downloadPathFile(file: PathFileRef, url: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.relativePath.split('/').at(-1) ?? ''
  anchor.click()
}

export const pathFilesApi = {
  sandboxContentUrl(path: string, download = false) {
    const query = new URLSearchParams({ path, ...(download ? { download: '1' } : {}) })
    return `${BASE_URL}/files/by-path/content?${query}`
  },
  downloadSandboxPath(path: string, filename: string) {
    const anchor = document.createElement('a')
    anchor.href = this.sandboxContentUrl(path, true)
    anchor.download = filename
    anchor.click()
  },
  async downloadArchive(directory: PathFileRef, paths: string[], filename = 'files.zip') {
    const response = await fetch(`${BASE_URL}${pathFileEndpoint(directory, 'download-archive')}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
      body: JSON.stringify({ paths }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const url = URL.createObjectURL(await response.blob())
    try {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
    } finally { URL.revokeObjectURL(url) }
  },
  compressArchive: (directory: PathFileRef, paths: string[], name: string) =>
    post<{ relativePath: string }>(pathFileEndpoint(directory, 'compress'), { paths, name }),
  extractArchive: (file: PathFileRef, folderName: string) =>
    post<{ relativePath: string; skipped: number }>(pathFileEndpoint(file, 'extract'), { folderName }),
  resolveRelative: (file: PathFileRef, paths: string[]) =>
    post<Array<{ path: string; file: { relativePath: string; name: string } | null; folder: { relativePath: string; name: string } | null }>>(pathFileEndpoint(file, 'resolve-relative'), { paths }),
  reference: (file: PathFileRef, kind: 'file' | 'folder' = 'file') =>
    get<{ type: 'file' | 'folder'; id: string; label: string }>(pathFileEndpoint(file, 'reference') + (kind === 'folder' ? '&kind=folder' : '')),
  entries: (directoryId: PathDirectory, relativePath = '') =>
    get<PathFileEntry[]>(pathFileEndpoint({ directoryId, relativePath }, 'entries')),
  contentUrl: pathContentUrl,
  thumbnailUrl: (file: PathFileRef) => `${BASE_URL}${pathFileEndpoint(file, 'thumb')}`,
  createFolder: (file: PathFileRef) => post<{ ok: boolean }>(pathFileEndpoint(file, 'folders')),
  move: (file: PathFileRef, destination: string) =>
    patch<{ ok: boolean }>(pathFileEndpoint(file, 'entries'), { destination }),
  copy: (file: PathFileRef, destination: string) =>
    post<{ ok: boolean }>(pathFileEndpoint(file, 'copy'), { destination }),
  moveToTrash: (file: PathFileRef) => del(pathFileEndpoint(file, 'entries')),
  async upload(file: PathFileRef, content: File, onProgress: (progress: number) => void, overwrite = false) {
    const form = new FormData()
    form.append('file', content)
    return uploadWithProgress(pathFileEndpoint(file, 'content') + (overwrite ? '&overwrite=1' : ''), form, onProgress)
  },
  saveText(file: PathFileRef, content: string) {
    const name = file.relativePath.split('/').at(-1) || 'file'
    const form = new FormData()
    form.append('file', new Blob([content], { type: 'text/plain' }), name)
    return upload(pathFileEndpoint(file, 'content') + '&overwrite=1', form)
  },
  async download(file: PathFileRef) {
    downloadPathFile(file, pathContentUrl(file, true))
  },
}

export interface DiskTrashEntry {
  id: string
  name: string
  relativePath: string
  kind: 'file' | 'directory'
  deletedAt: string
}

export const diskTrashApi = {
  list: () => get<DiskTrashEntry[]>('/files/disk-trash'),
  restore: (id: string) => post(`/files/disk-trash/${encodeURIComponent(id)}/restore`, {}),
  purge: (id: string) => del(`/files/disk-trash/${encodeURIComponent(id)}`),
}

export const workspaceDirectoriesApi = {
  list: () => get<WorkspaceDirectory[]>('/workspace-directories'),
  create: (name: string) => post<WorkspaceDirectory>('/workspace-directories', { name }),
  update: (id: number, name: string) => request<WorkspaceDirectory>('PATCH', `/workspace-directories/${id}`, { name }),
  previewDelete: async (id: number) => workspaceDirectoryPreviewResponse(
    await get<WorkspaceDirectoryPreviewWire>(`/workspace-directories/${id}/delete-preview`),
  ),
  delete: (id: number) => del(`/workspace-directories/${id}`),
}

export type TerminalAccessStatus = Awaited<ReturnType<typeof workspacesApi.status>>

/** 终端入口与后端 page_access 保持同一套 Shell 能力判定。 */
export function canAccessTerminals(status: TerminalAccessStatus): boolean {
  return status.terminalEntryEnabled
}

export type TerminalItem = {
  id: string
  name: string
  sessionId: number | null
  workspaceId: number | null
  runId: string | null
  source: 'user' | 'agent'
  mode: 'interactive-pty' | 'agent-events'
  status: string
  shellMode: string
  networkProfile: string
  lastSequence: number
  outputChars: number
  createdAt: string
  updatedAt: string
  closedAt: string | null
  ptyPid?: number | null
  ptySandboxId?: string | null
  ptyCols?: number | null
  ptyRows?: number | null
}

export type TerminalEventItem = {
  sequence: number
  type: string
  source: string | null
  runId: string | null
  command: string | null
  stdout: string
  stderr: string
  exitCode: number | null
  occurredAt: string
}

export const terminalsApi = {
  list: () => get<{ enabled: boolean; ptyEnabled: boolean; items: TerminalItem[] }>('/terminals'),
  create: (data: { name?: string; sessionId?: number; workspaceId?: number; mode?: TerminalItem['mode'] }) => post<TerminalItem>('/terminals', data),
  detail: (id: string) => get<TerminalItem>(`/terminals/${encodeURIComponent(id)}`),
  events: async (id: string, after = 0, signal?: AbortSignal, onEvent?: (event: TerminalEventItem) => void): Promise<void> => {
    const headers: Record<string, string> = { 'X-Client-Id': CLIENT_ID }
    const res = await fetch(`${BASE_URL}/terminals/${encodeURIComponent(id)}/events?after=${after}`, { headers, signal })
    if (isUnauthorizedResponse(res)) return
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const consume = (line: string) => {
      if (!line.startsWith('data: ')) return
      try {
        const event = (JSON.parse(line.slice(6)) as { event?: TerminalEventItem }).event
        if (event) onEvent?.(event)
      } catch { /* 不完整的 SSE 行会在下一次读取时重新拼接 */ }
    }
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(consume)
      if (chunk.done) break
    }
    if (buffer) consume(buffer)
  },
  rename: (id: string, name: string) => patch<TerminalItem>(`/terminals/${encodeURIComponent(id)}`, { name }),
  input: (id: string, data: {
    command: string
    cwd?: string
    timeout?: number
    maxOutputChars?: number
    network?: 'none' | 'egress'
    confirm?: boolean
    confirmCode?: string
  }) => post<{ terminal: TerminalItem; requestId: string; event: TerminalEventItem }>(`/terminals/${encodeURIComponent(id)}/input`, data),
  cancel: (id: string, requestId: string) => post<{ cancelled: boolean; requestId?: string }>(`/terminals/${encodeURIComponent(id)}/cancel/${encodeURIComponent(requestId)}`, {}),
  terminate: (id: string) => post<TerminalItem>(`/terminals/${encodeURIComponent(id)}/terminate`, {}),
  reopen: (id: string) => post<TerminalItem>(`/terminals/${encodeURIComponent(id)}/reopen`, {}),
  reset: (id: string) => post<TerminalItem>(`/terminals/${encodeURIComponent(id)}/reset`, {}),
  delete: (id: string) => del<{ deleted: boolean; terminalId: string }>(`/terminals/${encodeURIComponent(id)}`),
  metrics: () => get<{ total: number; running: number; outputChars: number; retentionDays: number; outputRetentionChars: number }>('/terminals/metrics'),
}

export const notificationsApi = {
  list:        ()    => get('/notifications'),                       // 通知中心：近期持久通知 + 未读态
  latestBubble: ()   => get('/notifications/bubble'),               // 上线补弹：最近一条有效气泡（{bubble:null|{...}}）
  markRead:    (ids?: number[] | null) => request('POST', '/notifications/read', { ids: ids ?? null }),  // 无 ids = 全部已读
  clear:       ()    => del<{ ok: boolean; dismissed: number }>('/notifications'), // 仅清除当前用户的通知视图
}

export const agentApi = {
  rebuildSandbox: () => post<{ ok: boolean; operation: string; root_ready: boolean; reclaimed_containers: number }>('/agent/sandbox/rebuild'),
  listSessions:    ()                  => get('/agent/sessions'),
  listCommands:    ()                  => get<{ commands: Array<{ command: string; label: string; description: string; insert: string }> }>('/agent/commands'),
  getUiLabels:     ()                  => get<{ thinking?: string[]; contextCompacting?: string[] }>('/agent/ui-labels'),
  getVoiceAvailability: ()             => get<{ available: boolean }>('/agent/voice-availability'),
  greeting:        (locale: SupportedLocale = getLocale()) => get<{ text?: string; enabled?: boolean }>(`/agent/greeting?locale=${encodeURIComponent(locale)}`), // 对话框默认问候（咕咕据近期记忆生成）
  getMessages: (sessionId: string | number, page: {
    beforeId?: number; afterId?: number; throughId?: number; runId?: string
    limit?: number; restoreInteractions?: boolean
  } = {}) => {
    const params = new URLSearchParams()
    if (page.beforeId != null) params.set('before_id', String(page.beforeId))
    if (page.afterId != null) params.set('after_id', String(page.afterId))
    if (page.throughId != null) params.set('through_id', String(page.throughId))
    if (page.runId != null) params.set('run_id', page.runId)
    if (page.limit != null) params.set('limit', String(page.limit))
    if (page.restoreInteractions) params.set('restore_interactions', 'true')
    const query = params.toString()
    return get(`/agent/sessions/${sessionId}/messages${query ? `?${query}` : ''}`)
  },
  getToolEventDetails: (sessionId: number, source: { kind: 'timeline'; messageId: number; index: number }) => {
    const params = new URLSearchParams({ source: 'timeline', message_id: String(source.messageId), timeline_index: String(source.index) })
    return get<{ toolInput?: unknown; toolResult?: unknown }>(`/agent/sessions/${sessionId}/tool-event-details?${params.toString()}`)
  },
  getInteractionSession: (promptId: number) => get<{ session_id: number }>(`/agent/interactions/${promptId}/session`),
  getPendingQueue: (queueId: string) => get<{ sessionId: number | null; items: Array<{ key: number; queue_id: string; session_id: number | null; claimed: boolean; text: string; attachments: any[]; references: any[] }> }>(`/agent/pending-queues/${encodeURIComponent(queueId)}`),
  listImportedDraftQueues: () => get<{ queues: Array<{ queue_id: string; items: Array<{ key: number; queue_id: string; session_id: null; claimed: boolean; text: string; attachments: any[]; references: any[] }> }> }>('/agent/pending-queues/imported-drafts'),
  updatePendingQueue: (queueId: string, items: Array<{ key: number; text: string; attachments: any[]; references: any[] }>) =>
    put(`/agent/pending-queues/${encodeURIComponent(queueId)}`, { items }),
  patchPendingQueue: (queueId: string, sessionId: number, items: Array<{ key: number; text: string; attachments: any[]; references: any[] }>, removeKeys: number[] = []) =>
    request('PATCH', `/agent/pending-queues/${encodeURIComponent(queueId)}`, { session_id: sessionId, items, remove_keys: removeKeys }),
  claimPendingQueueItem: (queueId: string, sessionId: number, key: number) =>
    post<{ claim_token: string | null; reason?: string }>(`/agent/pending-queues/${encodeURIComponent(queueId)}/items/${key}/claim`, { session_id: sessionId }),
  releasePendingQueueItem: (queueId: string, sessionId: number, key: number, claimToken: string) =>
    post<{ released: boolean }>(`/agent/pending-queues/${encodeURIComponent(queueId)}/items/${key}/release`, { session_id: sessionId, claim_token: claimToken }),
  getSessionState: (sessionId: string) => get<{ executionState: string; pendingMessageCount: number; active: boolean }>(`/agent/sessions/${sessionId}/state`),
  requestFilesystemAuthorization: (id: number) => post<Record<string, any>>(`/agent/sessions/${id}/filesystem-authorization/request`),
  confirmFilesystemAuthorization: (id: number, confirmCode: string) => post(`/agent/sessions/${id}/filesystem-authorization`, { confirm_code: confirmCode }),
  revokeFilesystemAuthorization: (id: number) => del(`/agent/sessions/${id}/filesystem-authorization`),
  cancelSession:   (sessionId: string) => post<{
    ok: boolean; active: boolean; recovered: boolean; cancelled_locally: boolean;
    outcome: 'requested' | 'interrupted' | 'already_completed'
  }>(`/agent/sessions/${sessionId}/cancel`),
  // 按消息 id 反查它所在的会话——笔记里的「@对话」引用锚定的是具体一条消息，点开时得先
  // 知道属于哪个会话才能 loadSession + 定位滚动
  getMessageLocation: (messageId: number) => get<{ id: number; sessionId: number }>(`/agent/messages/${messageId}`),
  deleteSession:   (sessionId: string) => del(`/agent/sessions/${sessionId}`),
  renameSession:   (sessionId: string, title: string) => patch(`/agent/sessions/${sessionId}`, { title }),
  clearMemory:       ()         => del('/agent/memory'),
  clearAttachments:  ()         => del('/agent/attachments'),
  // 发送失败时删掉本次关联的草稿附件（best-effort，降低草稿孤儿产生速度；
  // 后端只在附件仍是草稿态时才真的删，已被使用的附件会拒绝，见 PRD-STORAGE-1）
  deleteDraftAttachment: (attachId: string) => del(`/agent/attachment/${attachId}`),
  uploadAttachment: (file: File, voice = false) => {   // 聊天附件暂存，返回统一附件元数据
    const form = new FormData()
    form.append('file', file)
    if (voice) form.append('voice', 'true')      // 录音 → 语音条 + 30 天独立存储
    return upload('/agent/upload', form)
  },
}

export const onboardingApi = {
  getState:  ()             => get('/onboarding/state'),
  updateState: (patch: Record<string, unknown>) => request('PATCH', '/onboarding/state', patch),
  reopen:     ()             => post('/onboarding/state/reopen'),
  devReseed: ()             => post('/onboarding/dev/reseed'),
  devResetGuide: ()         => post('/onboarding/dev/reset-guide'),
}

export const trackApi = {
  track: (event: string, properties?: any) => request('POST', '/track', { event, properties }),
}

// 飞书 OAuth 扫码绑定
// 用户自带机器人（BYO：飞书 / QQ）
export const userBotsApi = {
  list:   ()                     => request('GET',    '/me/bots'),
  create: (body: any)            => request('POST',   '/me/bots', body),
  update: (id: number, body: any) => request('PUT',    `/me/bots/${id}`, body),
  remove: (id: number)           => request('DELETE', `/me/bots/${id}`),
  unbindQqIdentity: (id: number) => request('DELETE', `/me/bots/${id}/qq-binding`),
  createQqBindingCode: (id: number) => request('POST', `/me/bots/${id}/qq-binding-code`),
}

// QQ 扫码自动连接（建 task → 轮询 → 自动填 key）
export const qqConnectApi = {
  start: ()               => request('POST', '/me/qq/connect'),
  poll:  (taskId: string) => request('GET',  `/me/qq/connect/${taskId}`),
}

// 飞书扫码自动连接（device flow → 轮询 → 自动填 key）
export const feishuConnectApi = {
  start: ()               => request('POST', '/me/feishu/connect'),
  poll:  (pollId: string) => request('GET',  `/me/feishu/connect/${pollId}`),
}

// 微信 iLink 扫码自动连接（个人微信；出码 = base64 PNG → 轮询 → 自动写 bot_token）
export const wechatConnectApi = {
  start: ()               => request('POST', '/me/wechat/connect'),
  poll:  (taskId: string) => request('GET',  `/me/wechat/connect/${taskId}`),
}

// Telegram Bot Token 仅通过请求体提交，绝不拼入应用自身 URL。
export const telegramConnectApi = {
  connect: (token: string) => request('POST', '/me/telegram/connect', { token }),
  replace: (botId: number, token: string) => request('PUT', `/me/telegram/connect/${botId}`, { token }),
  createBindingCode: (botId: number) => request('POST', `/me/telegram/connect/${botId}/binding-code`),
}
