// 仅共享桌面 DTO 和固定能力名称；不依赖 Electron 或 Node。
export { CORE_SCHEMA_VERSION } from './schema.js'
export const MAX_FRAME = 65_536
export const DESKTOP_METHODS = [
  'core.info',
  'projects.list',
  'projects.create',
  'projects.rename',
  'clients.list',
  'clients.create',
  'clients.update',
  'operations.get',
  'executor.diagnostics',
] as const
export const DESKTOP_MUTATIONS: readonly string[] = [
  'projects.create',
  'projects.rename',
  'clients.create',
  'clients.update',
]
export const DESKTOP_CHANNELS = {
  projects: 'gugu:projects:list',
  createProject: 'gugu:projects:create',
  renameProject: 'gugu:projects:rename',
  clients: 'gugu:clients:list',
  createClient: 'gugu:clients:create',
  renameClient: 'gugu:clients:rename',
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
export interface DesktopClient {
  id: number
  name: string
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
  projects(): Promise<DesktopReply<DesktopProject[]>>
  createProject(name: string): Promise<DesktopReply<DesktopProject>>
  renameProject(id: number, version: number, name: string): Promise<DesktopReply<DesktopProject>>
  clients(): Promise<DesktopReply<DesktopClient[]>>
  createClient(name: string): Promise<DesktopReply<DesktopClient>>
  renameClient(id: number, name: string): Promise<DesktopReply<DesktopClient>>
  receipt(operationId: string): Promise<DesktopReply<unknown>>
  undoPreview(contextId: string): Promise<DesktopReply<unknown>>
  undoApply(contextId: string, undoId: string, operationId: string): Promise<DesktopReply<unknown>>
  undoRedo(contextId: string, undoId: string, operationId: string): Promise<DesktopReply<unknown>>
  sandboxStatus(): Promise<DesktopReply<SandboxStatus>>
}
