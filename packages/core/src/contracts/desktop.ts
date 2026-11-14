// 仅共享桌面 DTO 和固定能力名称；不依赖 Electron 或 Node。
export const MAX_FRAME = 65_536
export const DESKTOP_METHODS = [
  'core.info',
  'projects.list',
  'projects.create',
  'projects.rename',
  'clients.list',
  'clients.create',
  'operations.get',
  'executor.diagnostics',
] as const
export const DESKTOP_MUTATIONS: readonly string[] = [
  'projects.create',
  'projects.rename',
  'clients.create',
]
export const DESKTOP_CHANNELS = {
  projects: 'gugu:projects:list',
  createProject: 'gugu:projects:create',
  clients: 'gugu:clients:list',
  createClient: 'gugu:clients:create',
  receipt: 'gugu:operations:get',
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
  clients(): Promise<DesktopReply<DesktopClient[]>>
  createClient(name: string): Promise<DesktopReply<DesktopClient>>
  receipt(operationId: string): Promise<DesktopReply<unknown>>
  sandboxStatus(): Promise<DesktopReply<SandboxStatus>>
}
