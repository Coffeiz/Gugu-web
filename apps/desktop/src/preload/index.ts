import {
  applicationEditKeys, applicationMenuChannels,
  type ApplicationEditAction, type ApplicationMenuBridge, type ApplicationMenuCommand,
} from '@gugu/desktop-contracts'
import { nativeEditingChannel, type EditingFocus } from '../keyboard-editing.js'
import { createNativeFileDragGuard } from './native-file-drag.js'
import { previewWindowChannels, projectWindowChannels, type PreviewWindowBridge, type ProjectWindowBridge } from '@gugu/desktop-contracts'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { DesktopBridge, DesktopProjectCollection } from '@gugu/core/desktop'
import type { DesktopAppearancePreferences } from '@gugu/core/desktop'

if (typeof window !== 'undefined') {
  let lastFocus: EditingFocus | undefined
  function syncNativeEditing() {
    const focused = document.activeElement
    const selection = window.getSelection()
    const editable = focused instanceof HTMLElement && focused.isContentEditable
    const needsEditorHistory = editable && !!focused.closest('.ProseMirror, .cm-content')
    const native = editable || !!focused?.closest('input, textarea, select') || (!!selection && !selection.isCollapsed)
    const focus = needsEditorHistory ? 'editor' : native ? 'native' : 'page'
    if (focus === lastFocus) return
    lastFocus = focus
    ipcRenderer.send(nativeEditingChannel, focus)
  }
  document.addEventListener('focusin', syncNativeEditing, true)
  document.addEventListener('focusout', () => queueMicrotask(syncNativeEditing), true)
  document.addEventListener('selectionchange', syncNativeEditing)
  syncNativeEditing()

  const setNativeDragSource = createNativeFileDragGuard(window, file => webUtils.getPathForFile(file))
  ipcRenderer.on(DESKTOP_CHANNELS.nativeFileDragSource, (_event, path: unknown) => {
    setNativeDragSource(typeof path === 'string' ? path : null)
  })
}

// 菜单可能在主窗口刚加载、Vue 壳层尚未订阅时触发。
const pendingMenuCommands: ApplicationMenuCommand[] = []
let menuListener: ((command: ApplicationMenuCommand) => void) | undefined
ipcRenderer.on(applicationMenuChannels.command, (_event, command: ApplicationMenuCommand) => {
  if (menuListener) menuListener(command)
  else pendingMenuCommands.push(command)
})
ipcRenderer.on(applicationMenuChannels.edit, (_event, action: ApplicationEditAction) => {
  if (!Object.hasOwn(applicationEditKeys, action)) return
  const target = document.activeElement ?? document.body
  target?.dispatchEvent(new KeyboardEvent('keydown', {
    key: applicationEditKeys[action], metaKey: true, shiftKey: action === 'redo',
    bubbles: true, cancelable: true, composed: true,
  }))
})
const applicationMenu: ApplicationMenuBridge = {
  onCommand(listener) {
    menuListener = listener
    for (const command of pendingMenuCommands.splice(0)) listener(command)
    return () => { if (menuListener === listener) menuListener = undefined }
  },
}
contextBridge.exposeInMainWorld('guguApplicationMenu', applicationMenu)

type CanvasItemAddBody = Parameters<DesktopBridge['addCanvasItem']>[1]
type CanvasItemFrontBody = Parameters<DesktopBridge['bringCanvasItemToFront']>[2]
type CanvasRelationBody = Parameters<DesktopBridge['createCanvasRelation']>[0]
type CanvasNoteBody = Parameters<DesktopBridge['createCanvasNote']>[1]

const bridge: DesktopBridge = Object.freeze({
  remoteByok: (...args: Parameters<DesktopBridge['remoteByok']>) => ipcRenderer.invoke(DESKTOP_CHANNELS.remoteByok, ...args),
  remoteAccount: () => ipcRenderer.invoke(DESKTOP_CHANNELS.remoteAccount),
  remoteLogin: (input: Parameters<DesktopBridge['remoteLogin']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.remoteLogin, input),
  remoteLogout: () => ipcRenderer.invoke(DESKTOP_CHANNELS.remoteLogout),
  qqPairing: (command: Parameters<DesktopBridge['qqPairing']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.qqPairing, command),
  feishuPairing: (command: Parameters<DesktopBridge['feishuPairing']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.feishuPairing, command),
  wechatPairing: (command: Parameters<DesktopBridge['wechatPairing']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.wechatPairing, command),
  telegramGateway: (command: Parameters<DesktopBridge['telegramGateway']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.telegramGateway, command),
  terminal: (command: Parameters<DesktopBridge['terminal']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.terminal, command),
  personalSmtp: (...args: Parameters<DesktopBridge['personalSmtp']>) => ipcRenderer.invoke(DESKTOP_CHANNELS.personalSmtp, ...args),
  mail: (command: Parameters<DesktopBridge['mail']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.mail, command),
  createDroppedFileReference: (file: File) => ipcRenderer.invoke(DESKTOP_CHANNELS.createDroppedFileReference, webUtils.getPathForFile(file)),
  openDroppedFileReference: (id: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.openDroppedFileReference, id),
  startFileDrag: (directoryId: Parameters<NonNullable<DesktopBridge['startFileDrag']>>[0], path: string, preview?: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.startFileDrag, directoryId, path, preview),
  files: (command: Parameters<DesktopBridge['files']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.files, command),
  auxiliaryModel: (command: Parameters<DesktopBridge['auxiliaryModel']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.auxiliaryModel, command),
  agentModel: (command: Parameters<DesktopBridge['agentModel']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentModel, command),
  onAgentRunChanged: (callback: Parameters<NonNullable<DesktopBridge['onAgentRunChanged']>>[0]) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: number) => callback(sessionId)
    ipcRenderer.on(DESKTOP_CHANNELS.agentRunChanged, listener)
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.agentRunChanged, listener)
  },
  onAgentChatEvent: (callback: Parameters<NonNullable<DesktopBridge['onAgentChatEvent']>>[0]) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on(DESKTOP_CHANNELS.agentChatEvent, listener)
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.agentChatEvent, listener)
  },
  agentSessions: (command: Parameters<DesktopBridge['agentSessions']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentSessions, command),
  agentAttachment: (command: Parameters<NonNullable<DesktopBridge['agentAttachment']>>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentAttachment, command),
  resources: (command: Parameters<DesktopBridge['resources']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.resources, command),
  scheduleTask: (command: Parameters<DesktopBridge['scheduleTask']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.scheduleTask, command),
  onScheduleChanged: (callback: () => void) => subscribeDesktopEvent(DESKTOP_CHANNELS.scheduleChanged, callback),
  readLogs: (kind: Parameters<DesktopBridge['readLogs']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.readLogs, kind),
  applyBusinessArchive: (id: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.applyBusinessArchive, id),
  preflightBusinessArchive: () => ipcRenderer.invoke(DESKTOP_CHANNELS.preflightBusinessArchive),
  exportBusinessArchive: () => ipcRenderer.invoke(DESKTOP_CHANNELS.exportBusinessArchive),
  dataInventory: () => ipcRenderer.invoke(DESKTOP_CHANNELS.dataInventory),
  agentUsage: () => ipcRenderer.invoke(DESKTOP_CHANNELS.agentUsage),
  agentPreference: (...args: Parameters<DesktopBridge['agentPreference']>) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentPreference, ...args),
  clearAgentMemory: () => ipcRenderer.invoke(DESKTOP_CHANNELS.clearAgentMemory),
  clearAgentAttachments: () => ipcRenderer.invoke(DESKTOP_CHANNELS.clearAgentAttachments),
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
  purgeBoardProject: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.purgeBoardProject, id),
  restoreBoardProject: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.restoreBoardProject, id),
  clients: () => ipcRenderer.invoke(DESKTOP_CHANNELS.clients),
  createClient: (name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createClient, name),
  renameClient: (id: number, name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.renameClient, id, name),
  deleteClient: (id: number) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteClient, id),
  search: (queries: Parameters<DesktopBridge['search']>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.search, queries),
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

function subscribeDesktopEvent(channel: string, callback: () => void) {
  const listener = () => callback()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const projectWindow: ProjectWindowBridge = {
  open: id => ipcRenderer.invoke(projectWindowChannels.open, id),
  close: () => ipcRenderer.invoke(projectWindowChannels.close),
  onPrepareClose: callback => subscribeDesktopEvent(projectWindowChannels.prepareClose, callback),
  onUpdated: callback => {
    const listener = (_event: Electron.IpcRendererEvent, project: Parameters<typeof callback>[0]) => callback(project)
    ipcRenderer.on(projectWindowChannels.updated, listener)
    return () => ipcRenderer.removeListener(projectWindowChannels.updated, listener)
  },
  onClosed: callback => subscribeDesktopEvent(projectWindowChannels.closed, callback),
}
contextBridge.exposeInMainWorld('guguProjectWindow', projectWindow)

const previewWindow: PreviewWindowBridge = {
  open: file => ipcRenderer.invoke(previewWindowChannels.open, file),
  read: () => ipcRenderer.invoke(previewWindowChannels.read),
  close: () => ipcRenderer.invoke(previewWindowChannels.close),
  reveal: () => ipcRenderer.invoke(previewWindowChannels.reveal),
  state: (action, enabled) => ipcRenderer.invoke(previewWindowChannels.state, action, enabled),
  onStateChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state)
    ipcRenderer.on(previewWindowChannels.stateChanged, listener)
    return () => ipcRenderer.removeListener(previewWindowChannels.stateChanged, listener)
  },
}
contextBridge.exposeInMainWorld('guguPreviewWindow', previewWindow)
