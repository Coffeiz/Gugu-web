import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { DesktopBridge } from '@gugu/core/desktop'

const bridge: DesktopBridge = Object.freeze({
  projects: () => ipcRenderer.invoke(DESKTOP_CHANNELS.projects),
  createProject: (name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createProject, name),
  clients: () => ipcRenderer.invoke(DESKTOP_CHANNELS.clients),
  createClient: (name: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.createClient, name),
  receipt: (operationId: string) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.receipt, operationId),
  sandboxStatus: () => ipcRenderer.invoke(DESKTOP_CHANNELS.sandboxStatus),
  undoPreview: (contextId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.undoPreview, contextId),
  undoApply: (contextId: string, undoId: string, operationId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.undoApply, contextId, undoId, operationId),
  undoRedo: (contextId: string, undoId: string, operationId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.undoRedo, contextId, undoId, operationId),
})
contextBridge.exposeInMainWorld('guguDesktop', bridge)
