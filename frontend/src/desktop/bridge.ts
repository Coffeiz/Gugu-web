export interface ProjectRow { id: number; name: string; version: number }
export interface ClientRow { id: number; name: string }
export interface SandboxStatus { supported: boolean; methods: string[]; checkAvailable: boolean }

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
type DesktopWindow = Window & { __TAURI__?: { core?: { invoke?: Invoke } } }

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = (window as DesktopWindow).__TAURI__?.core?.invoke
  if (!bridge) return Promise.reject(new Error('请在咕咕桌面应用中打开本地工作台'))
  return bridge<T>(command, args)
}

export const desktopData = {
  projects: () => invoke<ProjectRow[]>('core_request', { method: 'projects.list', params: {} }),
  createProject: (name: string) => invoke<ProjectRow>('core_request', { method: 'projects.create', params: { name } }),
  clients: () => invoke<ClientRow[]>('core_request', { method: 'clients.list', params: {} }),
  createClient: (name: string) => invoke<ClientRow>('core_request', { method: 'clients.create', params: { name } }),
  sandboxStatus: () => invoke<SandboxStatus>('sandbox_status'),
  checkSandbox: () => invoke<{ passed: boolean; timedOut: boolean }>('sandbox_check'),
}
