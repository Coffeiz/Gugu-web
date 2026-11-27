import type { ChatImAccess } from '@/components/common/gugu-chat/composables/useChatImConnect'
import { hasDesktopTelegramGateway, requestDesktopTelegram } from '@desktop/bridge/bridge'
import { desktopFeishuConnectApi, hasDesktopFeishuPairing } from './connect/platforms/feishu/desktop'
import { desktopQqConnectApi, hasDesktopQqPairing } from './connect/platforms/qq/desktop'
import { desktopWechatConnectApi, hasDesktopWechatPairing } from './connect/platforms/wechat/desktop'

export function createDesktopChatImAccess(): ChatImAccess | undefined {
  const platforms = [
    { platform: 'feishu', available: hasDesktopFeishuPairing(), api: desktopFeishuConnectApi },
    { platform: 'qq', available: hasDesktopQqPairing(), api: desktopQqConnectApi },
    { platform: 'wechat', available: hasDesktopWechatPairing(), api: desktopWechatConnectApi },
  ] as const
  const available = platforms.filter(item => item.available)
  const telegramAvailable = hasDesktopTelegramGateway()
  if (!available.length && !telegramAvailable) return undefined
  return {
    connectTelegram: telegramAvailable ? token => requestDesktopTelegram({ action: 'save', input: { token } }) : undefined,
    generateTelegramBinding: telegramAvailable ? async () => {
      const snapshot = await requestDesktopTelegram({ action: 'bindingCode' })
      return snapshot.binding
    } : undefined,
    qr: Object.fromEntries(available.map(({ platform, api }) => [platform, api])),
    async listBots() {
      const results = await Promise.allSettled(available.map(async ({ platform, api }) => {
        const status = await api.status()
        const enabled = status.enabled && status.connectionState === 'running' && (platform !== 'qq' || status.bound === true)
        return status.configured ? { platform, enabled, connectionState: status.connectionState } : null
      }))
      const items = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
      const supported = available.map(item => item.platform)
      const telegram = telegramAvailable ? await requestDesktopTelegram({ action: 'status' }).catch(() => null) : null
      const telegramBot = telegram?.configured ? {
        platform: 'telegram' as const,
        enabled: telegram.bound && telegram.status === 'connected',
        ownerBound: telegram.bound,
        telegramStatus: telegram.status,
      } : null
      return {
        items: telegramBot ? [...items, telegramBot] : items,
        supported_platforms: telegramAvailable ? [...supported, 'telegram'] : supported,
      }
    },
  }
}
