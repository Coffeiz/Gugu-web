import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { DesktopBridge } from '@gugu/core/desktop'

const bridge: DesktopBridge = Object.freeze({
  projects: () => ipcRenderer.invoke(DESKTOP_CHANNELS.projects),
  createProject: (name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createProject, name),
  renameProject: (id: number, version: number, name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.renameProject, id, version, name),
  clients: () => ipcRenderer.invoke(DESKTOP_CHANNELS.clients),
  createClient: (name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createClient, name),
  renameClient: (id: number, name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.renameClient, id, name),
  deleteClient: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteClient, id),
  calendar: () => ipcRenderer.invoke(DESKTOP_CHANNELS.calendar),
  createCalendarEvent: (title: string, date: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createCalendarEvent, title, date),
  updateCalendarEvent: (id: number, body: { version: number; title?: string; date?: string }) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCalendarEvent, id, body),
  deleteCalendarEvent: (id: number, version: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteCalendarEvent, id, version),
  canvases: () => ipcRenderer.invoke(DESKTOP_CHANNELS.canvases),
  createCanvas: (title: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createCanvas, title),
  updateCanvas: (id: number, body: { title: string }) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCanvas, id, body),
  deleteCanvas: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteCanvas, id),
  canvasItems: (canvasId: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.canvasItems, canvasId),
  createCanvasNote: (canvasId: number, contentMd: string, color?: string, x?: number, y?: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.createCanvasNote, canvasId, { contentMd, color, x, y }),
  updateCanvasNote: (id: number, fields: { version: number; contentMd?: string; title?: string | null; color?: string | null }) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCanvasNote, id, fields),
  updateCanvasItem: (canvasId: number, id: number, body: { x?: number; y?: number; w?: number | null; h?: number | null }) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCanvasItem, canvasId, id, body),
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
