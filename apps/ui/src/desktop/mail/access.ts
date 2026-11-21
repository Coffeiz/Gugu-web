import type { MailAccess } from '@/api/mail'
import { requestDesktopMail } from '../bridge/bridge'

export const desktopMailAccess: MailAccess = {
  get preview() { return !('guguDesktop' in window) },
  async request<T>(command: Parameters<MailAccess['request']>[0]) {
    if (desktopMailAccess.preview) {
      if (command.action === 'accounts') return [] as T
      throw new Error('请在咕咕桌面应用中连接邮箱')
    }
    return await requestDesktopMail(command) as T
  },
}
