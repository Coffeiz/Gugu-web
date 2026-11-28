import { desktopData, hasDesktopFeishuPairing, hasDesktopQqPairing, hasDesktopTelegramGateway, hasDesktopWechatPairing, requestDesktopTelegram } from '@desktop/bridge/bridge'
import { desktopFeishuConnectApi } from './platforms/feishu/desktop'
import { desktopQqConnectApi } from './platforms/qq/desktop'
import { desktopWechatConnectApi } from './platforms/wechat/desktop'
import type { DesktopImSettingsAdapter } from '@/im/connect/desktopAdapter'

export const desktopImSettingsAdapter: DesktopImSettingsAdapter = {
  pairings: {
    ...(hasDesktopFeishuPairing() ? { feishu: desktopFeishuConnectApi } : {}),
    ...(hasDesktopQqPairing() ? { qq: desktopQqConnectApi } : {}),
    ...(hasDesktopWechatPairing() ? { wechat: desktopWechatConnectApi } : {}),
  },
  ...(hasDesktopQqPairing() ? { qq: desktopQqConnectApi } : {}),
  ...(hasDesktopTelegramGateway() ? { telegram: {
    async status() {
      const result = await requestDesktopTelegram({ action: 'status' })
      if (!('configured' in result)) throw new Error()
      return result
    },
    async updateGroupSettings(patch) {
      const result = await requestDesktopTelegram({ action: 'updateGroupSettings', patch })
      if (!('configured' in result)) throw new Error()
      return result
    },
    async setPrivateStreaming(enabled) {
      const result = await requestDesktopTelegram({ action: 'setPrivateStreaming', enabled })
      if (!('configured' in result)) throw new Error()
      return { ...result }
    },
  } } : {}),
  appearance: () => desktopData.appearance(),
  updateAppearance: patch => desktopData.updateAppearance(patch),
}
