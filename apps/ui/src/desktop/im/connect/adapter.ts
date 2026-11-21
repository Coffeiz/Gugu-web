import { desktopData, hasDesktopFeishuPairing, hasDesktopQqPairing, hasDesktopWechatPairing } from '@desktop/bridge/bridge'
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
  appearance: () => desktopData.appearance(),
  updateAppearance: patch => desktopData.updateAppearance(patch),
}
