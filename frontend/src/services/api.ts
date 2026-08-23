/**
 * 咕咕 API 客户端
 * 所有请求统一走这里，自动附加 user Bearer token
 */
import type { components } from '@/types/api'

// 后端 Pydantic 模型（由 OpenAPI 生成，见 npm run gen:types）。高频实体直接复用，前后端对齐。
type Schemas = components['schemas']

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

export function getToken(): string {
  return localStorage.getItem('user_token') ?? ''
}

// 本标签页的 client-id：每次写操作作为 X-Client-Id 头发给后端，后端把它塞进 SSE 事件的 origin。
// 前端收到「origin === 自己」的回声时跳过重拉（本页已乐观更新过），只让别的标签页/端刷新。
// 每标签页独立（内存级、不持久化）——刷新页面换一个新 id 也无妨，回声抑制只是优化不影响正确性。
export const CLIENT_ID: string =
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

// 泛型默认 any：未显式标注返回类型的调用方拿到 any（不给存量代码添堵）；
// 标注了 <T> 的端点拿到精确类型。逐步把更多端点标上类型即可收紧。
async function request<T = any>(method: string, path: string, body: any = null, isForm = false,
                                signal?: AbortSignal): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { 'X-Client-Id': CLIENT_ID }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const opts: RequestInit = { method, headers, signal }
  if (body !== null) {
    if (isForm) {
      opts.body = body
    } else {
      headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
  }

  const res = await fetch(`${BASE_URL}${path}`, opts)

  if (!res.ok) {
    // token 失效时自动清除并跳转登录
    if (res.status === 401) {
      localStorage.removeItem('user_token')
      window.location.href = '/login'
      throw new Error('请重新登录')
    }
    const err = await res.json().catch(() => ({}))
    const d = err.detail
    const msg = !d ? `HTTP ${res.status}`
      : typeof d === 'string' ? d
      : Array.isArray(d) ? d.map((e: any) => e.msg ?? e).join('；')
      : `HTTP ${res.status}`
    const apiErr = new Error(msg) as Error & { status?: number }
    apiErr.status = res.status
    throw apiErr
  }

  if (res.status === 204) return null as T
  return res.json()
}

const get    = <T = any>(path: string)             => request<T>('GET',    path)
const post   = <T = any>(path: string, body?: any) => request<T>('POST',   path, body)
const patch  = <T = any>(path: string, body?: any) => request<T>('PATCH',  path, body)
const put    = <T = any>(path: string, body?: any) => request<T>('PUT',    path, body)
const del    = <T = any>(path: string)             => request<T>('DELETE', path)
const upload = <T = any>(path: string, form: FormData) => request<T>('POST', path, form, true)

export function uploadWithProgress(path: string, form: FormData, onProgress: (p: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE_URL}${path}`)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('X-Client-Id', CLIENT_ID)   // 上传也带 client-id，供后端回声抑制
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) } catch { resolve(null) }
      } else {
        try {
          const d = JSON.parse(xhr.responseText).detail
          const msg = !d ? `HTTP ${xhr.status}`
            : typeof d === 'string' ? d
            : Array.isArray(d) ? d.map((e: any) => e.msg ?? e).join('；')
            : `HTTP ${xhr.status}`
          reject(new Error(msg))
        } catch { reject(new Error(`HTTP ${xhr.status}`)) }
      }
    }
    xhr.onerror = () => reject(new Error('网络错误'))
    xhr.send(form)
  })
}

export function uploadDirectWithProgress(url: string, file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    if (file.type) xhr.setRequestHeader('Content-Type', file.type)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`OSS 直传失败: HTTP ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('网络错误'))
    xhr.send(file)
  })
}

// ── Projects ─────────────────────────────────────────────────────────────────
export const projectsApi = {
  list:   (archived = false)                       => get<Schemas['ProjectResponse'][]>(`/projects${archived ? '?archived=true' : ''}`),
  get:    (id: number)                             => get<Schemas['ProjectResponse']>(`/projects/${id}`),
  create: (data: Schemas['ProjectCreate'])         => post<Schemas['ProjectResponse']>('/projects', data),
  update: (id: number, data: Schemas['ProjectUpdate']) => patch<Schemas['ProjectResponse']>(`/projects/${id}`, data),
  delete: (id: number)                             => del(`/projects/${id}`),
}

// ── ScheduledTasks（定时任务）─────────────────────────────────────────────────
export const scheduledTasksApi = {
  list:         ()                  => get('/scheduled-tasks'),
  listForEvent: (eventId: number)   => get(`/scheduled-tasks?event_id=${eventId}`),   // 某日历活动绑定的提醒
  create:       (data: any)         => post('/scheduled-tasks', data),
  update:       (id: number, data: any) => patch(`/scheduled-tasks/${id}`, data),
  delete:       (id: number)        => del(`/scheduled-tasks/${id}`),
  run:          (id: number)        => post(`/scheduled-tasks/${id}/run`),
  testNotify:   (data: any)         => post('/scheduled-tasks/test-notify', data),   // 测试提醒渠道（不建任务）
}

// ── Files ─────────────────────────────────────────────────────────────────────
interface FileListParams {
  space?: string
  projectId?: number
  folderId?: number
  mindMapId?: number
  ext?: string
  q?: string
}
export const filesApi = {
  list: ({ space, projectId, folderId, mindMapId, ext, q }: FileListParams = {}) => {
    const p: Record<string, any> = {}
    if (space      != null) p.space       = space
    if (projectId  != null) p.project_id  = projectId
    if (folderId   != null) p.folder_id   = folderId
    if (mindMapId  != null) p.mind_map_id = mindMapId
    if (ext        != null) p.ext         = ext
    if (q          != null) p.q           = q
    const qs = new URLSearchParams(p).toString()
    return get<Schemas['FileResponse'][]>(`/files${qs ? '?' + qs : ''}`)
  },
  tree:    ()         => get('/files/tree'),
  all:     ()         => get<Schemas['FileResponse'][]>('/files/all'),
  version: ()         => get('/files/version'),
  storage: ()         => get('/files/storage'),
  update: (id: number, data: Schemas['FileUpdate']) => patch<Schemas['FileResponse']>(`/files/${id}`, data),
  saveContent: (id: number, content: string) => put<Schemas['FileResponse']>(`/files/${id}/content`, { content }),   // 改文本正文（md 勾选框等）
  delete:      (id: number)   => del(`/files/${id}`),
  batchDelete: (ids: number[])  => post('/files/batch-delete', { ids }),
  copy: (id: number, body: Schemas['FileCopyBody']) => post<Schemas['FileResponse']>(`/files/${id}/copy`, body),
  batchDownload: async (ids: number[], folderIds: number[] = [], filename = 'files.zip') => {
    const token = getToken()
    const res = await fetch(`${BASE_URL}/files/batch-download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ids, folderIds }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  },
  presign: (data: any) => post('/files/presign', data),
  confirm: (data: any) => post('/files/confirm', data),
  // 批量探测同名冲突（上传前调用），items: [{filename, space, projectId?, folderId?}]
  checkConflicts: (items: { filename: string; space: string; projectId?: number | null; folderId?: number | null }[]) =>
    post<{ filename: string; conflict: boolean; existing_file: any }[]>('/files/check-conflicts', {
      items: items.map(it => ({ filename: it.filename, space: it.space, project_id: it.projectId ?? null, folder_id: it.folderId ?? null })),
    }),
  // 返回 { url: "https://..." }，后端签名 URL，有效期短（5~10 分钟）
  getStreamUrl: (id: number) => get(`/files/${id}/stream-url`),
  download: async (id: number, filename: string) => {
    const token = getToken()
    const res = await fetch(`${BASE_URL}/files/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
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

// ── Events ────────────────────────────────────────────────────────────────────
export const eventsApi = {
  list:   (year: number, month: number) => get<Schemas['EventResponse'][]>(`/events?year=${year}&month=${month}`),
  get:    (id: number) => get<Schemas['EventResponse']>(`/events/${id}`),
  create: (data: Schemas['EventCreate']) => post<Schemas['EventResponse']>('/events', data),
  update: (id: number, data: Schemas['EventUpdate']) => patch<Schemas['EventResponse']>(`/events/${id}`, data),
  delete: (id: number)          => del(`/events/${id}`),
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
  type: 'project' | 'file' | 'event' | 'conversation'
  id: number
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

export const mindApi = {
  listNotes:  (limit = 50, offset = 0) => get<MindNote[]>(`/mind/notes?limit=${limit}&offset=${offset}`),
  createNote: (data: MindNoteCreate)             => post<MindNote>('/mind/notes', data),
  updateNote: (id: number, data: MindNoteUpdate) => patch<MindNote>(`/mind/notes/${id}`, data),
  deleteNote: (id: number)                       => del(`/mind/notes/${id}`),
  refSuggest: (q: string, limit = 6) =>
    get<MindRefSuggestItem[]>(`/mind/ref-suggest?q=${encodeURIComponent(q)}&limit=${limit}`),
  listCanvases: () => get<MindCanvas[]>('/mind/canvases'),
  createCanvas: (data: { title?: string; projectId?: number | null } = {}) =>
    post<MindCanvas>('/mind/canvases', data),
  updateCanvas: (id: number, data: { title?: string; data?: Record<string, unknown> }) =>
    patch<MindCanvas>(`/mind/canvases/${id}`, data),
  deleteCanvas: (id: number) => del(`/mind/canvases/${id}`),
  listCanvasItems: (id: number) => get<MindCanvasItem[]>(`/mind/canvases/${id}/items`),
  addCanvasItem: (id: number, data: { nodeId: number; x?: number; y?: number; w?: number | null; h?: number | null; z?: number; collapsed?: boolean; data?: Record<string, unknown> }) =>
    post<MindCanvasItem>(`/mind/canvases/${id}/items`, data),
  createCanvasNote: (id: number, data: MindCanvasNoteCreate) =>
    post<MindCanvasItem>(`/mind/canvases/${id}/notes`, data),
  updateCanvasNote: (id: number, data: { title?: string; contentMd?: string; color?: string | null; version: number }) =>
    patch<MindNote>(`/mind/nodes/${id}`, data),
  updateCanvasItem: (canvasId: number, itemId: number, data: Partial<Pick<MindCanvasItem, 'x' | 'y' | 'w' | 'h' | 'z' | 'collapsed' | 'data'>>) =>
    patch<MindCanvasItem>(`/mind/canvases/${canvasId}/items/${itemId}`, data),
  bringCanvasItemToFront: (canvasId: number, itemId: number, data: { x: number; y: number }) =>
    post<MindCanvasItem>(`/mind/canvases/${canvasId}/items/${itemId}/bring-to-front`, data),
  removeCanvasItem: (canvasId: number, itemId: number) => del(`/mind/canvases/${canvasId}/items/${itemId}`),
  listCanvasRelations: (id: number) => get<MindRelation[]>(`/mind/canvases/${id}/relations`),
  createRelation: (srcNodeId: number, dstNodeId: number, allowParallel = false) =>
    post<MindRelation>('/mind/relations', { srcNodeId, dstNodeId, allowParallel }),
  deleteRelation: (id: number) => del(`/mind/relations/${id}`),
  createRefNode: (refType: 'project' | 'file' | 'event', refId: number) =>
    post<MindNote>('/mind/nodes/ref', { refType, refId }),
}

// ── Folders ───────────────────────────────────────────────────────────────────
export const foldersApi = {
  all:  ()                              => get<Schemas['FolderResponse'][]>('/folders/all'),
  list: ({ projectId, parentId }: { projectId?: number; parentId?: number } = {}) => {
    const params = new URLSearchParams()
    if (projectId != null) params.set('project_id', String(projectId))
    if (parentId  != null) params.set('parent_id',  String(parentId))
    const qs = params.toString()
    return get<Schemas['FolderResponse'][]>(qs ? `/folders?${qs}` : '/folders')
  },
  create: (projectId: number | null, name: string, parentId: number | null = null) => post<Schemas['FolderResponse']>('/folders', {
    ...(projectId != null ? { projectId } : {}),
    ...(parentId  != null ? { parentId  } : {}),
    name,
  }),
  // version：乐观锁，必传当前文件夹的 version（改名/移动即失效，见 stores/filesCache 的更新逻辑）；
  // 版本对不上后端给 409，同 projectsApi.update 的并发保护模式。
  rename: (id: number, name: string, version: number) =>
    patch<Schemas['FolderResponse']>(`/folders/${id}`, { name, version }),
  move:   (id: number, parentId: number | null, version: number, projectId: number | null = null) =>
    patch<Schemas['FolderResponse']>(`/folders/${id}/parent`, { parentId, version, projectId }),
  copy:   (id: number, parentId: number | null, projectId: number | null) =>
    post<Schemas['FolderResponse']>(`/folders/${id}/copy`, { parentId, projectId }),
  delete: (id: number)           => del(`/folders/${id}`),
  download: async (id: number, name: string) => {
    const token = getToken()
    const res = await fetch(`${BASE_URL}/folders/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.zip`
    a.click()
    URL.revokeObjectURL(url)
  },
}

// ── Trash ─────────────────────────────────────────────────────────────────────
export type TrashFolderMeta = Schemas['TrashFolderResponse']
export interface TrashFolderContents {
  folders: TrashFolderMeta[]
  files: Schemas['FileResponse'][]
}

export const trashApi = {
  list:          ()           => get('/trash'),
  listFolders:   ()           => get<TrashFolderMeta[]>('/trash/folders'),
  listFolderContents: (id: number) => get<TrashFolderContents>(`/trash/folders/${id}/contents`),
  restore:       (id: number) => post(`/trash/${id}/restore`, {}),
  restoreFolder: (id: number) => post(`/trash/folders/${id}/restore`, {}),
  hardDeleteFolder: (id: number) => del(`/trash/folders/${id}`),
  hardDelete:    (id: number) => del(`/trash/${id}`),
  empty:         ()           => del('/trash'),
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
}

export const workspacesApi = {
  status: () => get<{ globalEnabled: boolean; userEnabled: boolean; dangerousGlobalEnabled: boolean; userDangerousEnabled: boolean; items: unknown[] }>('/workspaces'),
  create: (data: { name: string; kind: 'folder' | 'project'; folderId?: number; projectId?: number }) => post('/workspaces', data),
  update: (id: number, data: { name?: string; enabled?: boolean }) => request('PATCH', `/workspaces/${id}`, data),
  delete: (id: number) => del(`/workspaces/${id}`),
  current: (sessionId: number) => get(`/workspaces/session/${sessionId}`),
  bind: (workspaceId: number, sessionId: number) => post(`/workspaces/${workspaceId}/bind/${sessionId}`),
  unbind: (sessionId: number) => del(`/workspaces/binding/${sessionId}`),
}

export const notificationsApi = {
  list:        ()    => get('/notifications'),                       // 通知中心：近期持久通知 + 未读态
  latestBubble: ()   => get('/notifications/bubble'),               // 上线补弹：最近一条有效气泡（{bubble:null|{...}}）
  markRead:    (ids?: number[] | null) => request('POST', '/notifications/read', { ids: ids ?? null }),  // 无 ids = 全部已读
}

export const agentApi = {
  listSessions:    ()                  => get('/agent/sessions'),
  getUiLabels:     ()                  => get('/agent/ui-labels'),   // 状态显示名（目前用「思考中」文字）
  greeting:        ()                  => get('/agent/greeting'),    // 对话框默认问候（咕咕据近期记忆生成）
  getMessages:     (sessionId: string) => get(`/agent/sessions/${sessionId}/messages`),
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
  uploadAttachment: (file: File, voice = false) => {   // 聊天附件暂存，返回 { attach_id, name, ext, size, kind, duration }
    const form = new FormData()
    form.append('file', file)
    if (voice) form.append('voice', 'true')      // 录音 → 语音条 + 30 天独立存储
    return upload('/agent/upload', form)
  },
}

export const onboardingApi = {
  getState:  ()             => get('/onboarding/state'),
  claim:     (key: string)  => post(`/onboarding/claim/${key}`),
  // demo（作用于当前用户自己）
  devPools:  ()             => get('/onboarding/dev/pools'),
  devFire:   (key: string)  => post(`/onboarding/dev/fire/${key}`),
  devReset:  ()             => post('/onboarding/dev/reset'),
  devReseed: ()             => post('/onboarding/dev/reseed'),
}

export const trackApi = {
  track: (event: string, properties?: any) => request('POST', '/track', { event, properties }),
}

// 站内全局搜索（顶栏搜索框）
export const searchApi = {
  query: (queries: string[], signal?: AbortSignal) => {
    const params = new URLSearchParams({ mode: 'OR' })
    for (const query of queries) params.append('queries', query)
    return request('GET', `/search?${params.toString()}`, null, false, signal)
  },
}

export const authApi = {
  updateProfile: (data: any)     => request('PATCH',  '/auth/profile', data),
  getQuota:      ()              => request('GET',    '/auth/quota'),
  deleteAccount: (password: string) => request('DELETE', '/auth/me', { password }),
  uploadAvatar:  (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request('POST', '/auth/avatar', fd, true)
  },
}

// 飞书 OAuth 扫码绑定
// 用户自带机器人（BYO：飞书 / QQ）
export const userBotsApi = {
  list:   ()                     => request('GET',    '/me/bots'),
  create: (body: any)            => request('POST',   '/me/bots', body),
  update: (id: number, body: any) => request('PUT',    `/me/bots/${id}`, body),
  remove: (id: number)           => request('DELETE', `/me/bots/${id}`),
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
