import type { ScheduleAccess } from '@/services/scheduleAccess'
import { desktopWechatConnectApi } from '../im/connect/platforms/wechat/desktop'
import { desktopSchedules } from '../bridge/bridge'

export const desktopScheduleAccess: ScheduleAccess = {
  ...desktopSchedules,
  storesSchedulesLocally: true,
  async channels() {
    const result = await desktopSchedules.channels()
    if (result.channels.includes('wechat')) return result
    const wechat = await desktopWechatConnectApi.status().catch(() => null)
    return { ...result, wechatNeedsMessage: wechat?.configured === true && wechat.enabled === true }
  },
  update: (id, fields, change) => desktopSchedules.update(id, fields, change?.eventId),
}
