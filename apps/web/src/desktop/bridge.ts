import type { DesktopBridge, DesktopProject, DesktopClient, DesktopCalendarEvent, DesktopCanvas, DesktopCanvasItem, DesktopNote, DesktopReply } from '@gugu/core/desktop'
import type { DesktopAppearancePreferences, DesktopOnboardingState } from '@gugu/core/desktop'
export type { SandboxStatus } from '@gugu/core/desktop'
export type ProjectRow = DesktopProject
export type ClientRow = DesktopClient
export type CalendarRow = DesktopCalendarEvent
export type CanvasRow = DesktopCanvas
export type CanvasItemRow = DesktopCanvasItem
export type NoteRow = DesktopNote
type DesktopWindow = Window & { guguDesktop?: DesktopBridge }

export class DesktopBridgeError extends Error {
  constructor(readonly code: string, message: string, readonly operationId?: string) {
    super(message)
  }
}

async function call<T>(action: (bridge: DesktopBridge) => Promise<DesktopReply<T>>): Promise<T> {
  const bridge = (window as DesktopWindow).guguDesktop ?? (createPreviewBridge())
  if (!bridge) throw new Error('请在咕咕桌面应用中打开本地工作台')
  const reply = await action(bridge)
  if (reply.ok === false) throw new DesktopBridgeError(reply.error.code, reply.error.message, reply.error.operationId)
  return reply.result
}

function createPreviewBridge(): DesktopBridge | undefined {
  if (!import.meta.env.DEV || new URLSearchParams(location.search).get('desktopPreview') !== '1') return undefined
  const defaults = {
    appearance: { theme: 'light', themeFamily: 'glass', palette: 'neutral' },
    onboarding: { should_show: false, guide: { enabled: false, current_step: '', completed_steps: [], dismissed: false, completed_at: null, should_show: false }, seed: {} },
    sandboxStatus: { supported: false, methods: [], checkAvailable: false, reason: '浏览器预览模式' },
  }
  const arrayMethods = new Set(['projects', 'clients', 'calendar', 'canvases', 'canvasItems', 'notes'])
  const previewCanvases: DesktopCanvas[] = []
  let nextCanvasId = 1
  return new Proxy({} as DesktopBridge, {
    get: (_target, key: string) => {
      if (key === 'canvases') return async () => ({ ok: true, result: [...previewCanvases] })
      if (key === 'createCanvas') return async (title = '未命名画布') => {
        const now = new Date().toISOString()
        const canvas: DesktopCanvas = { id: nextCanvasId++, title, projectId: null, data: {}, createdAt: now, updatedAt: now }
        previewCanvases.unshift(canvas)
        return { ok: true, result: canvas }
      }
      return async () => ({ ok: true, result: key in defaults ? defaults[key as keyof typeof defaults] : arrayMethods.has(key) ? [] : null })
    },
  })
}

export const desktopData = {
  appearance: () => call(bridge => bridge.appearance()),
  updateAppearance: (patch: Partial<DesktopAppearancePreferences>) => call(bridge => bridge.updateAppearance(patch)),
  onboarding: () => call(bridge => bridge.onboarding()),
  projects: () => call(bridge => bridge.projects()),
  createProject: (name: string) => call(bridge => bridge.createProject(name)),
  renameProject: (id: number, version: number, name: string) => call(bridge => bridge.renameProject(id, version, name)),
  clients: () => call(bridge => bridge.clients()),
  createClient: (name: string) => call(bridge => bridge.createClient(name)),
  renameClient: (id: number, name: string) => call(bridge => bridge.renameClient(id, name)),
  deleteClient: (id: number) => call(bridge => bridge.deleteClient(id)),
  calendar: () => call(bridge => bridge.calendar()),
  createCalendarEvent: (title: string, date: string, details?: { time?: string | null; endTime?: string | null; description?: string | null }) => call(bridge => bridge.createCalendarEvent(title, date, details)),
  updateCalendarEvent: (id: number, body: { version: number; title?: string; date?: string; time?: string | null; endTime?: string | null; description?: string | null }) => call(bridge => bridge.updateCalendarEvent(id, body)),
  deleteCalendarEvent: (id: number, version: number) => call(bridge => bridge.deleteCalendarEvent(id, version)),
  canvases: () => call(bridge => bridge.canvases()),
  createCanvas: (title: string) => call(bridge => bridge.createCanvas(title)),
  updateCanvas: (id: number, body: { title?: string; data?: Record<string, unknown> }) => call(bridge => bridge.updateCanvas(id, body)),
  deleteCanvas: (id: number) => call(bridge => bridge.deleteCanvas(id)),
  canvasItems: (canvasId: number) => call(bridge => bridge.canvasItems(canvasId)),
  canvasRelations: (canvasId: number) => call(bridge => bridge.canvasRelations(canvasId)),
  addCanvasItem: (canvasId: number, body: { nodeId: number; x?: number; y?: number; w?: number | null; h?: number | null; z?: number; collapsed?: boolean; data?: Record<string, unknown> }) => call(bridge => bridge.addCanvasItem(canvasId, body)),
  bringCanvasItemToFront: (canvasId: number, id: number, body: { x: number; y: number }) => call(bridge => bridge.bringCanvasItemToFront(canvasId, id, body)),
  createCanvasRelation: (body: { canvasId: number; srcNodeId: number; dstNodeId: number; allowParallel?: boolean }) => call(bridge => bridge.createCanvasRelation(body)),
  deleteCanvasRelation: (canvasId: number, id: number) => call(bridge => bridge.deleteCanvasRelation(canvasId, id)),
  createRefNode: (refType: 'project' | 'file' | 'event', refId: number) => call(bridge => bridge.createRefNode(refType, refId)),
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
