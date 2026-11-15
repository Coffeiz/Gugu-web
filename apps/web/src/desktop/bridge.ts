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
  const bridge = (window as DesktopWindow).guguDesktop
  if (!bridge) throw new Error('请在咕咕桌面应用中打开本地工作台')
  const reply = await action(bridge)
  if (reply.ok === false) throw new DesktopBridgeError(reply.error.code, reply.error.message, reply.error.operationId)
  return reply.result
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
  createCalendarEvent: (title: string, date: string) => call(bridge => bridge.createCalendarEvent(title, date)),
  updateCalendarEvent: (id: number, body: { version: number; title?: string; date?: string }) => call(bridge => bridge.updateCalendarEvent(id, body)),
  deleteCalendarEvent: (id: number, version: number) => call(bridge => bridge.deleteCalendarEvent(id, version)),
  canvases: () => call(bridge => bridge.canvases()),
  createCanvas: (title: string) => call(bridge => bridge.createCanvas(title)),
  updateCanvas: (id: number, body: { title: string }) => call(bridge => bridge.updateCanvas(id, body)),
  deleteCanvas: (id: number) => call(bridge => bridge.deleteCanvas(id)),
  canvasItems: (canvasId: number) => call(bridge => bridge.canvasItems(canvasId)),
  createCanvasNote: (canvasId: number, contentMd: string, color?: string, x?: number, y?: number) => call(bridge => bridge.createCanvasNote(canvasId, contentMd, color, x, y)),
  updateCanvasNote: (id: number, fields: { version: number; contentMd?: string; title?: string | null; color?: string | null }) => call(bridge => bridge.updateCanvasNote(id, fields)),
  updateCanvasItem: (canvasId: number, id: number, body: { x?: number; y?: number; w?: number | null; h?: number | null }) => call(bridge => bridge.updateCanvasItem(canvasId, id, body)),
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
