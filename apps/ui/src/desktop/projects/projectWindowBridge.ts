import type { DesktopReply } from '@gugu/core/desktop'
import type { ProjectWindowBridge } from '@gugu/desktop-contracts'
import { DesktopBridgeError } from '@desktop/bridge/bridge'

export const projectWindowBridge = (window as Window & { guguProjectWindow?: ProjectWindowBridge }).guguProjectWindow

export async function projectWindowResult<T>(reply: Promise<DesktopReply<T>>) {
  const response = await reply
  if (response.ok === false) throw new DesktopBridgeError(response.error.code, response.error.message)
  return response.result
}
