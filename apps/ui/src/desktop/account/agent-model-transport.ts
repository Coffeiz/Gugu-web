import type { DesktopBridge, DesktopReply } from '@gugu/core/desktop'
import { DesktopBridgeError } from '@desktop/bridge/bridge'
import { agentModelPreviewPath } from '@gugu/desktop-contracts'

type DesktopWindow = Window & { guguDesktop?: DesktopBridge }
const nativeBridge = () => (window as DesktopWindow).guguDesktop
const previewEnabled = () => import.meta.env.DEV && new URLSearchParams(location.search).get('desktopPreview') === '1'

function available(method: 'agentModel' | 'auxiliaryModel') {
  const bridge = nativeBridge()
  return bridge ? typeof bridge[method] === 'function' : previewEnabled()
}

async function requestModel<T>(method: 'agentModel' | 'auxiliaryModel', command: unknown,
  invoke: (bridge: DesktopBridge) => Promise<DesktopReply<T>>,
): Promise<T> {
  if (!available(method))
    throw new DesktopBridgeError('desktop_update_required', '请更新并重启咕咕后配置模型')
  const bridge = nativeBridge()
  let reply: DesktopReply<T>
  if (bridge) reply = await invoke(bridge)
  else {
    const response = await fetch(agentModelPreviewPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args: [command] }),
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
      throw new DesktopBridgeError('preview_unavailable', '本机模型配置服务未就绪')
    reply = await response.json()
  }
  if (reply.ok === false) throw new DesktopBridgeError(reply.error.code, reply.error.message, reply.error.operationId)
  return reply.result
}

export function hasDesktopAgentModelBridge() { return available('agentModel') }
export function hasDesktopAuxiliaryModelBridge() { return available('auxiliaryModel') }

export function requestDesktopAuxiliaryModel(command: Parameters<DesktopBridge['auxiliaryModel']>[0]) {
  return requestModel('auxiliaryModel', command, bridge => bridge.auxiliaryModel(JSON.parse(JSON.stringify(command))))
}

type DesktopModelCommand = Parameters<DesktopBridge['agentModel']>[0]
export function requestDesktopAgentModel(command: DesktopModelCommand & { action: 'capabilities' }): Promise<import('@gugu/core/desktop').DesktopAgentModelCapabilities>
export function requestDesktopAgentModel(command: DesktopModelCommand & { action: 'probe' }): Promise<import('@gugu/core/desktop').DesktopAgentMediaResult>
export function requestDesktopAgentModel(command: DesktopModelCommand & { action: 'models' }): Promise<string[]>
export function requestDesktopAgentModel(command: DesktopModelCommand & { action: 'list' | 'put' | 'set_default' | 'delete' }): Promise<import('@gugu/core/desktop').DesktopAgentModelList>
export function requestDesktopAgentModel(command: DesktopModelCommand & { action: 'get' | 'save' | 'test' }): Promise<import('@gugu/core/desktop').DesktopAgentModel | null>
export function requestDesktopAgentModel(command: DesktopModelCommand) {
  return requestModel('agentModel', command, bridge => bridge.agentModel(JSON.parse(JSON.stringify(command))))
}
