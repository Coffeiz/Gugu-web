// 仅共享桌面 DTO 和固定能力名称；不依赖 Electron 或 Node。
export { CORE_SCHEMA_VERSION } from './schema.js'
export const MAX_FRAME = 65_536
export const DESKTOP_METHODS = [
  'core.info',
  'projects.list',
  'projects.create',
  'projects.rename',
  'projects.board.list',
  'projects.board.get',
  'projects.board.create',
  'projects.board.update',
  'projects.board.delete',
  'projects.board.restore',
  'clients.list',
  'clients.create',
  'clients.update',
  'clients.delete',
  'calendar.update',
  'calendar.delete',
  'preferences.desktop.get',
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
] as const
export const DESKTOP_MUTATIONS: readonly string[] = [
  'projects.create',
  'projects.rename',
  'projects.board.create',
  'projects.board.update',
  'projects.board.delete',
  'projects.board.restore',
  'clients.create',
  'clients.update',
  'clients.delete',
  'calendar.create',
  'calendar.update',
  'calendar.delete',
  'preferences.desktop.update',
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
  projects: 'gugu:projects:list',
  createProject: 'gugu:projects:create',
  renameProject: 'gugu:projects:rename',
  projectBoard: 'gugu:projects:board:list',
  projectDetails: 'gugu:projects:board:get',
  createBoardProject: 'gugu:projects:board:create',
  updateBoardProject: 'gugu:projects:board:update',
  deleteBoardProject: 'gugu:projects:board:delete',
  restoreBoardProject: 'gugu:projects:board:restore',
  clients: 'gugu:clients:list',
  createClient: 'gugu:clients:create',
  renameClient: 'gugu:clients:rename',
  deleteClient: 'gugu:clients:delete',
  calendar: 'gugu:calendar:list',
  appearance: 'gugu:preferences:appearance:get',
  updateAppearance: 'gugu:preferences:appearance:update',
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
export interface DesktopBridge {
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
  addCanvasItem(canvasId: number, body: { nodeId: number; x?: number; y?: number; w?: number | null; h?: number | null; z?: number; collapsed?: boolean; data?: Record<string, unknown> }): Promise<DesktopReply<DesktopCanvasItem>>
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
export interface DesktopAppearancePreferences {
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
