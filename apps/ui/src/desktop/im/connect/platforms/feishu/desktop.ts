import { hasDesktopFeishuPairing, requestDesktopFeishuPairing } from '@desktop/bridge/bridge'
import type { DesktopImGroupSettingsPatch } from '@/im/connect/desktopAdapter'

export { hasDesktopFeishuPairing }

export const desktopFeishuConnectApi = {
  async status(action: 'status' | 'enable' | 'disable' = 'status') {
    const result = await requestDesktopFeishuPairing({ action })
    if (!('configured' in result)) throw new Error()
    return result
  },
  async start() {
    const result = await requestDesktopFeishuPairing({ action: 'start' })
    if (!('poll_id' in result)) throw new Error()
    return result
  },
  async poll(taskId: string) {
    const result = await requestDesktopFeishuPairing({ action: 'poll', taskId })
    if (!('status' in result)) throw new Error()
    return result
  },
  async updateGroupSettings(patch: DesktopImGroupSettingsPatch) {
    const result = await requestDesktopFeishuPairing({ action: 'updateGroupSettings', patch })
    if (!('configured' in result)) throw new Error()
    return result
  },
  async setPrivateStreaming(enabled: boolean) {
    const result = await requestDesktopFeishuPairing({ action: 'setPrivateStreaming', enabled })
    if (!('configured' in result)) throw new Error()
    return result
  },
}
