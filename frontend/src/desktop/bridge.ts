import type { DesktopBridge, DesktopProject, DesktopClient, DesktopReply } from '../../../gugu-core/src/contracts/desktop'
export type { SandboxStatus } from '../../../gugu-core/src/contracts/desktop'
export type ProjectRow = DesktopProject
export type ClientRow = DesktopClient
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
  projects: () => call(bridge => bridge.projects()),
  createProject: (name: string) => call(bridge => bridge.createProject(name)),
  clients: () => call(bridge => bridge.clients()),
  createClient: (name: string) => call(bridge => bridge.createClient(name)),
  sandboxStatus: () => call(bridge => bridge.sandboxStatus()),
  receipt: (operationId: string) => call(bridge => bridge.receipt(operationId)),
}
