import { hasDesktopWechatPairing, requestDesktopWechatPairing } from '@desktop/bridge/bridge'

export { hasDesktopWechatPairing }

export const desktopWechatConnectApi = {
  async status(action: 'status' | 'enable' | 'disable' = 'status') {
    const result = await requestDesktopWechatPairing({ action })
    if (!('configured' in result)) throw new Error()
    return result
  },
  async start() {
    const result = await requestDesktopWechatPairing({ action: 'start' })
    if (!('task_id' in result)) throw new Error()
    return result
  },
  async poll(taskId: string) {
    const result = await requestDesktopWechatPairing({ action: 'poll', taskId })
    if (!('status' in result)) throw new Error()
    return result
  },
}
