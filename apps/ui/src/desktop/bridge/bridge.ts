import type { DesktopProject, DesktopClient, DesktopCalendarEvent, DesktopCanvas, DesktopCanvasItem, DesktopNote, DesktopReply } from '@gugu/core/desktop'
import type { DesktopAgentPreferenceKind, DesktopAgentPreferencePatch, DesktopAppearancePreferences, DesktopOnboardingState } from '@gugu/core/desktop'
import type { DesktopProjectCollection, DesktopProjectDetails, DesktopScheduleCommand, DesktopScheduledTask } from '@gugu/core/desktop'
import { desktopPreviewRoutes, projectBoardMethods, type DesktopBridge } from '@gugu/desktop-contracts'
export type { DesktopTelegramSnapshot, DesktopAgentMediaDimension, DesktopAgentModelCapabilities, DesktopAgentModel, DesktopAgentModelEntry, DesktopAgentModelList, DesktopAgentMessage, DesktopAgentSession, SandboxStatus } from '@gugu/core/desktop'
export type ProjectRow = DesktopProject
export type ClientRow = DesktopClient
export type CalendarRow = DesktopCalendarEvent
export type CanvasRow = DesktopCanvas
export type CanvasItemRow = DesktopCanvasItem
export type NoteRow = DesktopNote
type DesktopWindow = Window & { guguDesktop?: DesktopBridge }

export function nativeDesktopBridge() {
  return typeof window === 'undefined' ? undefined : (window as DesktopWindow).guguDesktop
}

export class DesktopBridgeError extends Error {
  constructor(readonly code: string, message: string, readonly operationId?: string) {
    super(message)
  }

  get status() {
    return this.code === 'conflict' ? 409 : this.code === 'not_found' ? 404 : undefined
  }
}

export function isDesktopRenderer() {
  return typeof window !== 'undefined' && (document.documentElement.dataset.desktopShell === 'true' || 'guguDesktop' in window)
}

async function call<T>(action: (bridge: DesktopBridge) => Promise<DesktopReply<T>>): Promise<T> {
  const bridge = (window as DesktopWindow).guguDesktop ?? (createPreviewBridge())
  if (!bridge) throw new Error('请在咕咕桌面应用中打开本地工作台')
  const reply = await action(bridge)
  if (reply.ok === false) throw new DesktopBridgeError(reply.error.code, reply.error.message, reply.error.operationId)
  return reply.result
}

export { call as callDesktopBridge }

function callProjectBoard<T>(action: (bridge: DesktopBridge) => Promise<DesktopReply<T>>): Promise<T> {
  return call(bridge => {
    if (projectBoardMethods.some(method => typeof bridge[method] !== 'function'))
      throw new DesktopBridgeError('desktop_update_required', '桌面应用版本过旧，请更新并重新启动后再操作项目')
    return action(bridge)
  })
}

const previewEndpoints = new Map<string, string>(
  desktopPreviewRoutes.flatMap(({ endpoint, methods }) => methods.map(method => [method, endpoint] as const)),
)
let previewBridge: DesktopBridge | undefined

async function callPreviewCore(endpoint: string, method: string, args: unknown[]): Promise<DesktopReply<unknown>> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new DesktopBridgeError('preview_unavailable', '本机预览服务未就绪，请通过桌面开发服务打开预览')
  }
  return response.json()
}

function createPreviewBridge(): DesktopBridge | undefined {
  if (!import.meta.env.DEV || new URLSearchParams(location.search).get('desktopPreview') !== '1') return undefined
  if (previewBridge) return previewBridge
  const defaults = {
    appearance: { theme: 'light', themeFamily: 'glass', palette: 'neutral' },
    sandboxStatus: { supported: false, methods: [], checkAvailable: false, reason: '浏览器预览模式' },
  }
  previewBridge = new Proxy({} as DesktopBridge, {
    get: (_target, key: string) => {
      const endpoint = previewEndpoints.get(key)
      if (endpoint) return (...args: unknown[]) => callPreviewCore(endpoint, key, args)
      return async () => ({ ok: true, result: key in defaults ? defaults[key as keyof typeof defaults] : null })
    },
  })
  return previewBridge
}

export function hasRemoteAccountBridge() {
  return typeof ((window as DesktopWindow).guguDesktop ?? createPreviewBridge())?.remoteAccount === 'function'
}

export function hasRemoteByokBridge() {
  return typeof ((window as DesktopWindow).guguDesktop ?? createPreviewBridge())?.remoteByok === 'function'
}

export function desktopRemoteByok(...args: Parameters<DesktopBridge['remoteByok']>) {
  return call(bridge => bridge.remoteByok(...args))
}

export const desktopRemoteAccount = {
  status: () => call(bridge => bridge.remoteAccount()),
  login: (input: Parameters<DesktopBridge['remoteLogin']>[0]) => call(bridge => bridge.remoteLogin(input)),
  logout: () => call(bridge => bridge.remoteLogout()),
}

export function requestDesktopTerminal(command: Parameters<DesktopBridge['terminal']>[0]) {
  return call(bridge => {
    if (typeof bridge.terminal !== 'function')
      throw new DesktopBridgeError('unsupported', '请使用支持终端的咕咕桌面应用')
    return bridge.terminal(command)
  })
}

export function requestDesktopMail(command: Parameters<DesktopBridge['mail']>[0]) {
  return call(bridge => {
    if (typeof bridge.mail !== 'function') throw new DesktopBridgeError('unsupported', '请使用支持邮箱的咕咕桌面应用')
    return bridge.mail(command)
  })
}

export async function requestDesktopFile(command: Parameters<DesktopBridge['files']>[0]) {
  if (command.action === 'upload' && !(window as DesktopWindow).guguDesktop && createPreviewBridge()) {
    const params = new URLSearchParams({ path: command.path, overwrite: command.overwrite ? '1' : '0' })
    if (command.directoryId) params.set('directoryId', command.directoryId)
    if (command.identity) params.set('identity', command.identity)
    const response = await fetch(`/__local-files/upload?${params}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(command.data).buffer,
    })
    const reply = await response.json() as DesktopReply<unknown>
    if (reply.ok === false) throw new DesktopBridgeError(reply.error.code, reply.error.message)
    return reply.result
  }
  return call(bridge => {
    if (typeof bridge.files !== 'function')
      throw new DesktopBridgeError('desktop_update_required', '请更新并重启咕咕后使用文件库')
    return bridge.files(command)
  })
}

export function hasDesktopFileDrag() {
  return typeof (window as DesktopWindow).guguDesktop?.startFileDrag === 'function'
}

export function startDesktopFileDrag(directoryId: import('@gugu/core/desktop').DesktopFileDirectory, path: string, preview?: string) {
  return call(bridge => {
    if (!bridge.startFileDrag) throw new DesktopBridgeError('unsupported', '请在咕咕桌面应用中拖出文件')
    return bridge.startFileDrag(directoryId, path, preview)
  })
}

export function hasDesktopQqPairing() {
  return typeof ((window as DesktopWindow).guguDesktop ?? createPreviewBridge())?.qqPairing === 'function'
}

export function requestDesktopQqPairing(command: Parameters<DesktopBridge['qqPairing']>[0]) {
  return call(bridge => bridge.qqPairing(command))
}

export function hasDesktopFeishuPairing() {
  return typeof ((window as DesktopWindow).guguDesktop ?? createPreviewBridge())?.feishuPairing === 'function'
}

export function requestDesktopFeishuPairing(command: Parameters<DesktopBridge['feishuPairing']>[0]) {
  return call(bridge => bridge.feishuPairing(command))
}

export function hasDesktopWechatPairing() {
  return typeof ((window as DesktopWindow).guguDesktop ?? createPreviewBridge())?.wechatPairing === 'function'
}

export function requestDesktopWechatPairing(command: Parameters<DesktopBridge['wechatPairing']>[0]) {
  return call(bridge => bridge.wechatPairing(command))
}

export function hasDesktopTelegramGateway() {
  return typeof ((window as DesktopWindow).guguDesktop ?? createPreviewBridge())?.telegramGateway === 'function'
}

export function requestDesktopTelegram(command: Parameters<DesktopBridge['telegramGateway']>[0]) {
  return call(bridge => bridge.telegramGateway(JSON.parse(JSON.stringify(command))))
}

function requestSchedule(command: DesktopScheduleCommand) {
  return call(bridge => {
    if (typeof bridge.scheduleTask !== 'function')
      throw new DesktopBridgeError('desktop_update_required', '请更新并重启咕咕后管理定时任务')
    return bridge.scheduleTask(command)
  })
}

function scheduleFields(data: Record<string, unknown>) {
  const { name, payload, schedule_kind, cron, interval_minutes, start_at, end_at, enabled, channels, execution_mode, reminder_lead_minutes, im_delivery } = data
  return Object.fromEntries(Object.entries({ name, payload, schedule_kind, cron, interval_minutes, start_at, end_at, enabled, channels, execution_mode, reminder_lead_minutes, im_delivery })
    .filter(([, value]) => value !== undefined))
}

export const desktopSchedules = {
  listDeliveryTargets: (platform: string) => requestSchedule({ action: 'targets', platform }) as Promise<{ groups: { chat_id: string; title: string }[]; private_available: boolean }>,
  channels: () => requestSchedule({ action: 'channels' }) as Promise<{ channels: string[] }>,
  async list(eventId?: number) {
    const tasks: DesktopScheduledTask[] = []
    let before: number | null = null
    do {
      const command: DesktopScheduleCommand = { action: 'list', ...(before === null ? {} : { before }), ...(eventId === undefined ? {} : { eventId }) }
      const page = await requestSchedule(command) as { tasks: DesktopScheduledTask[]; nextBefore: number | null }
      tasks.push(...page.tasks)
      before = page.nextBefore
    } while (before !== null)
    return { tasks }
  },
  create: (data: Record<string, unknown>, eventId?: number) =>
    requestSchedule({ action: 'create', fields: scheduleFields(data), ...(eventId === undefined ? {} : { eventId }) }) as Promise<DesktopScheduledTask>,
  update: (id: number, data: Record<string, unknown>, eventId?: number) =>
    requestSchedule({ action: 'update', id, fields: scheduleFields(data), ...(eventId === undefined ? {} : { eventId }) }) as Promise<DesktopScheduledTask>,
  delete: (id: number, eventId?: number) => requestSchedule({ action: 'delete', id, ...(eventId === undefined ? {} : { eventId }) }),
  run: (id: number) => requestSchedule({ action: 'run', id }) as Promise<{ msg: string }>,
  onChanged: (listener: () => void) => (window as DesktopWindow).guguDesktop?.onScheduleChanged?.(listener),
}

export const desktopData = {
  createDroppedFileReference: (file: File) => call(bridge => bridge.createDroppedFileReference!(file)),
  openDroppedFileReference: (id: string) => call(bridge => {
    if (typeof bridge.openDroppedFileReference !== 'function')
      throw new DesktopBridgeError('unsupported', '请更新桌面应用后打开本机文件')
    return bridge.openDroppedFileReference(id)
  }),
  search: (queries: string[], expansion?: number) => call(bridge => expansion === undefined ? bridge.search(queries) : bridge.search(queries, expansion)),
  readLogs: (kind: Parameters<DesktopBridge['readLogs']>[0]) => call(bridge => bridge.readLogs(kind)),
  appearance: () => call(bridge => bridge.appearance()),
  agentUsage: () => call(bridge => bridge.agentUsage()),
  agentPreference: (kind: DesktopAgentPreferenceKind, patch?: DesktopAgentPreferencePatch) => call(bridge => patch === undefined ? bridge.agentPreference(kind) : bridge.agentPreference(kind, patch)),
  clearAgentMemory: () => call(bridge => bridge.clearAgentMemory()),
  clearAgentAttachments: () => call(bridge => bridge.clearAgentAttachments()),
  updateAppearance: (patch: Partial<DesktopAppearancePreferences>) => call(bridge => bridge.updateAppearance(patch)),
  onboarding: (patch?: Record<string, unknown>, reopen?: true) => call(bridge => bridge.onboarding(patch, reopen)),
  projects: () => call(bridge => bridge.projects()),
  createProject: (name: string) => call(bridge => bridge.createProject(name)),
  renameProject: (id: number, version: number, name: string) => call(bridge => bridge.renameProject(id, version, name)),
  async projectBoard(collection: DesktopProjectCollection) {
    const projects: DesktopProjectDetails[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const currentOffset: number = offset
      const page = await callProjectBoard(bridge => bridge.projectBoard(collection, currentOffset))
      for (const project of page.items) projects.push(project)
      offset = page.nextOffset
    }
    return projects
  },
  projectDetails: (id: number) => callProjectBoard(bridge => bridge.projectDetails(id)),
  createBoardProject: (fields: Record<string, unknown>, operationId?: string) =>
    callProjectBoard(bridge => bridge.createBoardProject(JSON.parse(JSON.stringify(fields)), operationId)),
  updateBoardProject: (id: number, version: number, fields: Record<string, unknown>) =>
    callProjectBoard(bridge => bridge.updateBoardProject(id, version, JSON.parse(JSON.stringify(fields)))),
  deleteBoardProject: (id: number) => callProjectBoard(bridge => bridge.deleteBoardProject(id)),
  purgeBoardProject: (id: number) => callProjectBoard(bridge => {
    if (typeof bridge.purgeBoardProject !== 'function')
      throw new DesktopBridgeError('desktop_update_required', '请更新并重新启动桌面应用后再永久删除项目')
    return bridge.purgeBoardProject(id)
  }),
  restoreBoardProject: (id: number) => callProjectBoard(bridge => bridge.restoreBoardProject(id)),
  clients: () => call(bridge => bridge.clients()),
  clientRelated: (id: number) => call(bridge => bridge.clientRelated(id)),
  createClient: (fields: Parameters<DesktopBridge['createClient']>[0]) => call(bridge => bridge.createClient(fields)),
  renameClient: (id: number, fields: Parameters<DesktopBridge['renameClient']>[1]) => call(bridge => bridge.renameClient(id, fields)),
  deleteClient: (id: number) => call(bridge => bridge.deleteClient(id)),
  calendar: () => call(bridge => bridge.calendar()),
  createCalendarEvent: (title: string, date: string, details?: { time?: string | null; endTime?: string | null; description?: string | null }) => call(bridge => bridge.createCalendarEvent(title, date, details)),
  updateCalendarEvent: (id: number, body: { version: number; title?: string; date?: string; time?: string | null; endTime?: string | null; description?: string | null }) => call(bridge => bridge.updateCalendarEvent(id, body)),
  deleteCalendarEvent: (id: number, version: number) => call(bridge => bridge.deleteCalendarEvent(id, version)),
  canvases: () => call(bridge => bridge.canvases()),
  createCanvas: (title: string) => call(bridge => bridge.createCanvas(title)),
  // 画布数据可能来自响应式 Store，Electron IPC 只能接收可克隆的普通数据。
  updateCanvas: (id: number, body: { title?: string; data?: Record<string, unknown> }) =>
    call(bridge => bridge.updateCanvas(id, JSON.parse(JSON.stringify(body)))),
  deleteCanvas: (id: number) => call(bridge => bridge.deleteCanvas(id)),
  canvasItems: (canvasId: number) => call(bridge => bridge.canvasItems(canvasId)),
  canvasRelations: (canvasId: number) => call(bridge => bridge.canvasRelations(canvasId)),
  addCanvasItem: (canvasId: number, body: Parameters<DesktopBridge['addCanvasItem']>[1]) => call(bridge => bridge.addCanvasItem(canvasId, body)),
  bringCanvasItemToFront: (canvasId: number, id: number, body: { x: number; y: number }) => call(bridge => bridge.bringCanvasItemToFront(canvasId, id, body)),
  createCanvasRelation: (body: { canvasId: number; srcNodeId: number; dstNodeId: number; allowParallel?: boolean }) => call(bridge => bridge.createCanvasRelation(body)),
  deleteCanvasRelation: (canvasId: number, id: number) => call(bridge => bridge.deleteCanvasRelation(canvasId, id)),
  createRefNode: (refType: 'project' | 'file' | 'event' | 'client', refId: number) => call(bridge => bridge.createRefNode(refType, refId)),
  canvasNoteLocation: (nodeId: number) => call(bridge => bridge.canvasNoteLocation(nodeId)),
  createCanvasNote: (canvasId: number, body: { title?: string; contentMd?: string; color?: string | null; x?: number; y?: number; w?: number | null; h?: number | null; z?: number }) => call(bridge => bridge.createCanvasNote(canvasId, body)),
  updateCanvasNote: (id: number, fields: { version: number; contentMd?: string; title?: string | null; color?: string | null }) => call(bridge => bridge.updateCanvasNote(id, fields)),
  updateCanvasItem: (canvasId: number, id: number, body: { x?: number; y?: number; w?: number | null; h?: number | null; z?: number; collapsed?: boolean; data?: Record<string, unknown> }) => call(bridge => bridge.updateCanvasItem(canvasId, id, body)),
  deleteCanvasItem: (canvasId: number, id: number) => call(bridge => bridge.deleteCanvasItem(canvasId, id)),
  notes: () => call(bridge => bridge.notes()),
  createNote: (contentMd: string, color?: string) => call(bridge => bridge.createNote(contentMd, color)),
  updateNote: (id: number, fields: { version: number; contentMd?: string; title?: string | null; color?: string | null }) => call(bridge => bridge.updateNote(id, fields)),
  deleteNote: (id: number) => call(bridge => bridge.deleteNote(id)),
  undoPreview: (contextId: string) => call(bridge => bridge.undoPreview(contextId)),
  undoApply: (contextId: string, undoId: string, operationId: string) => call(bridge => bridge.undoApply(contextId, undoId, operationId)),
  undoRedo: (contextId: string, undoId: string, operationId: string) => call(bridge => bridge.undoRedo(contextId, undoId, operationId)),
  sandboxStatus: () => call(bridge => bridge.sandboxStatus()),
  receipt: (operationId: string) => call(bridge => bridge.receipt(operationId)),
}
