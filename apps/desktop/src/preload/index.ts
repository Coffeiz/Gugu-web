import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { DesktopBridge, DesktopProjectCollection } from '@gugu/core/desktop'
import type { DesktopAppearancePreferences } from '@gugu/core/desktop'

type CanvasItemAddBody = Parameters<DesktopBridge['addCanvasItem']>[1]
type CanvasItemFrontBody = Parameters<DesktopBridge['bringCanvasItemToFront']>[2]
type CanvasRelationBody = Parameters<DesktopBridge['createCanvasRelation']>[0]
type CanvasNoteBody = Parameters<DesktopBridge['createCanvasNote']>[1]

const bridge: DesktopBridge = Object.freeze({
  remoteByok: (...args: Parameters<DesktopBridge['remoteByok']>) => ipcRenderer.invoke(DESKTOP_CHANNELS.remoteByok, ...args),
  remoteAccount: () => ipcRenderer.invoke(DESKTOP_CHANNELS.remoteAccount),
  remoteLogin: (input: Parameters<DesktopBridge['remoteLogin']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.remoteLogin, input),
  remoteLogout: () => ipcRenderer.invoke(DESKTOP_CHANNELS.remoteLogout),
  appearance: () => ipcRenderer.invoke(DESKTOP_CHANNELS.appearance),
  updateAppearance: (patch: Partial<DesktopAppearancePreferences>) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateAppearance, patch),
  onboarding: () => ipcRenderer.invoke(DESKTOP_CHANNELS.onboarding),
  projects: () => ipcRenderer.invoke(DESKTOP_CHANNELS.projects),
  createProject: (name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createProject, name),
  renameProject: (id: number, version: number, name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.renameProject, id, version, name),
  projectBoard: (collection: DesktopProjectCollection, offset: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectBoard, collection, offset),
  projectDetails: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.projectDetails, id),
  createBoardProject: (fields: Record<string, unknown>, operationId?: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createBoardProject, fields, operationId),
  updateBoardProject: (id: number, version: number, fields: Record<string, unknown>) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateBoardProject, id, version, fields),
  deleteBoardProject: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteBoardProject, id),
  restoreBoardProject: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.restoreBoardProject, id),
  clients: () => ipcRenderer.invoke(DESKTOP_CHANNELS.clients),
  createClient: (name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createClient, name),
  renameClient: (id: number, name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.renameClient, id, name),
  deleteClient: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteClient, id),
  calendar: () => ipcRenderer.invoke(DESKTOP_CHANNELS.calendar),
  createCalendarEvent: (...args: Parameters<DesktopBridge['createCalendarEvent']>) => ipcRenderer.invoke(DESKTOP_CHANNELS.createCalendarEvent, ...args),
  updateCalendarEvent: (...args: Parameters<DesktopBridge['updateCalendarEvent']>) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCalendarEvent, ...args),
  deleteCalendarEvent: (id: number, version: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteCalendarEvent, id, version),
  canvases: () => ipcRenderer.invoke(DESKTOP_CHANNELS.canvases),
  createCanvas: (title: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createCanvas, title),
  updateCanvas: (id: number, body: { title?: string; data?: Record<string, unknown> }) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCanvas, id, body),
  deleteCanvas: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteCanvas, id),
  canvasItems: (canvasId: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.canvasItems, canvasId),
  canvasRelations: (canvasId: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.canvasRelations, canvasId),
  addCanvasItem: (canvasId: number, body: CanvasItemAddBody) => ipcRenderer.invoke(DESKTOP_CHANNELS.addCanvasItem, canvasId, body),
  bringCanvasItemToFront: (canvasId: number, id: number, body: CanvasItemFrontBody) => ipcRenderer.invoke(DESKTOP_CHANNELS.bringCanvasItemToFront, canvasId, id, body),
  createCanvasRelation: (body: CanvasRelationBody) => ipcRenderer.invoke(DESKTOP_CHANNELS.createCanvasRelation, body),
  deleteCanvasRelation: (canvasId: number, id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteCanvasRelation, canvasId, id),
  createRefNode: (refType: 'project' | 'file' | 'event', refId: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.createRefNode, refType, refId),
  canvasNoteLocation: (nodeId: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.canvasNoteLocation, nodeId),
  createCanvasNote: (canvasId: number, body: CanvasNoteBody) => ipcRenderer.invoke(DESKTOP_CHANNELS.createCanvasNote, canvasId, body),
  updateCanvasNote: (id: number, fields: { version: number; contentMd?: string; title?: string | null; color?: string | null }) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCanvasNote, id, fields),
  updateCanvasItem: (canvasId: number, id: number, body: Parameters<DesktopBridge['updateCanvasItem']>[2]) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCanvasItem, canvasId, id, body),
  deleteCanvasItem: (canvasId: number, id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteCanvasItem, canvasId, id),
  notes: () => ipcRenderer.invoke(DESKTOP_CHANNELS.notes),
  createNote: (contentMd: string, color?: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createNote, contentMd, color),
  updateNote: (id: number, fields: { version: number; contentMd?: string; title?: string | null; color?: string | null }) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateNote, id, fields),
  deleteNote: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteNote, id),
  receipt: (operationId: string) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.receipt, operationId),
  sandboxStatus: () => ipcRenderer.invoke(DESKTOP_CHANNELS.sandboxStatus),
  undoPreview: (contextId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.undoPreview, contextId),
  undoApply: (contextId: string, undoId: string, operationId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.undoApply, contextId, undoId, operationId),
  undoRedo: (contextId: string, undoId: string, operationId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.undoRedo, contextId, undoId, operationId),
})
contextBridge.exposeInMainWorld('guguDesktop', bridge)
