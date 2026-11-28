import { hasDesktopQqPairing, requestDesktopQqPairing } from '@desktop/bridge/bridge'
import type { DesktopImGroupSettingsPatch } from '@/im/connect/desktopAdapter'

export { hasDesktopQqPairing }

export const desktopQqConnectApi = {
  async status(action: 'status' | 'enable' | 'disable' = 'status') {
    const result = await requestDesktopQqPairing({ action })
    if (!('configured' in result)) throw new Error()
    return result
  },
  async setMessageFormat(scope: 'group' | 'private', format: 'compat' | 'markdown') {
    const result = await requestDesktopQqPairing({ action: scope === 'group' ? 'setGroupMessageFormat' : 'setPrivateMessageFormat', format })
    if (!('configured' in result)) throw new Error()
    return result
  },
  async setPrivateStreaming(enabled: boolean) {
    const result = await requestDesktopQqPairing({ action: 'setPrivateStreaming', enabled })
    if (!('configured' in result)) throw new Error()
    return result
  },
  async updateGroupSettings(patch: DesktopImGroupSettingsPatch) {
    const result = await requestDesktopQqPairing({ action: 'updateGroupSettings', patch })
    if (!('configured' in result)) throw new Error()
    return result
  },
  async unbind() {
    const result = await requestDesktopQqPairing({ action: 'unbind' })
    if (!('configured' in result)) throw new Error()
    return result
  },
  async bindingCode() {
    const result = await requestDesktopQqPairing({ action: 'bindingCode' })
    if (!('code' in result)) throw new Error()
    return result
  },
  async start() {
    const result = await requestDesktopQqPairing({ action: 'start' })
    if (!('task_id' in result)) throw new Error()
    return result
  },
  async poll(taskId: string) {
    const result = await requestDesktopQqPairing({ action: 'poll', taskId })
    if (!('status' in result)) throw new Error()
    return result
  },
}
