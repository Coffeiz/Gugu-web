import { userBotGroupToolFlags } from '@gugu/core/im/user-bots'
import { createFeishuBotApi } from '@gugu/core/im/feishu-bot-api'
import { createILinkClient } from '@gugu/gateway/wechat'
import { createTelegramAdapter } from '@gugu/gateway/telegram'
import { createQqClient, createQqProactiveSender } from '@gugu/gateway/qq'
import type { ProviderTransport } from '@gugu/core/providers'
import { desktopScheduleImTarget, desktopSchedulePrivateBinding, type DesktopScheduleImPlatform, type DesktopScheduleImTarget } from '../../../../../packages/core/src/runtime/desktop-schedules/desktop-im.js'
import { DesktopError } from '../core-host.js'

type Bot = { appId: string; appSecret: string; enabled: boolean; userId: string | null;
  privateMessageFormat?: 'compat' | 'markdown'; groupMessageFormat?: 'compat' | 'markdown';
  groupChatEnabled?: boolean; groupMemoryEnabled?: boolean; groupHistorySearchEnabled?: boolean }

export function createDesktopScheduledIm(options: {
  feishu(): Promise<Bot | null | undefined>
  qq(): Promise<Bot | null | undefined>
  telegram(): Promise<Bot | null | undefined>
  wechat(): Promise<(Bot & { baseUrl: string; contextToken: string }) | null>
  transport(): ProviderTransport & { close(): Promise<void> }
}) {
  async function active(target: DesktopScheduleImTarget): Promise<(Bot & { userId: string }) | null> {
    const bot = await options[target.platform]()
    if (!bot?.enabled || !bot.userId) return null
    if (target.chatType === 'group'
      && (!bot.groupChatEnabled || bot.appId !== target.botId || bot.userId !== target.boundUserId)) return null
    return { ...bot, userId: bot.userId }
  }

  return {
    async privateTarget(platform: DesktopScheduleImPlatform) {
      const bot = await options[platform]()
      return bot?.enabled && bot.userId
        ? desktopSchedulePrivateBinding.parse({ platform, botId: bot.appId, boundUserId: bot.userId, chatType: 'c2c', recipient: bot.userId })
        : null
    },
    async authorize(input: unknown) {
      const target = desktopScheduleImTarget.parse(input)
      const bot = await active(target)
      return bot ? { groupMemoryEnabled: bot.groupMemoryEnabled !== false, groupHistorySearchEnabled: bot.groupHistorySearchEnabled === true } : null
    },
    async deliver(input: unknown, text: string, signal: AbortSignal) {
      const target = desktopScheduleImTarget.parse(input)
      const bot = await active(target)
      if (!bot) throw new DesktopError('conflict', '定时任务的 IM 投递授权已变化')
      const transport = options.transport()
      const group = target.chatType === 'group'
      const recipient = group ? target.recipient : bot.userId
      const stillBound = async () => {
        const latest = await active(target)
        return latest?.appId === bot.appId && latest.userId === bot.userId
      }
      try {
        if (target.platform === 'qq') {
          const client = createQqClient({ ...bot, sandbox: false, transport: { request: transport.request.bind(transport) } })
          const send = createQqProactiveSender({ botId: bot.appId, client, sanitizeText: value => value })
          try {
            const result = await send({
              id: recipient, chatType: target.chatType,
              messageFormat: group ? bot.groupMessageFormat : bot.privateMessageFormat,
            }, text, signal, stillBound)
            if (result.outcome !== 'accepted')
              throw new DesktopError('schedule_failed', 'QQ 定时任务投递失败')
          } finally {
            await client.close()
          }
        } else if (target.platform === 'telegram') {
          const { sender } = createTelegramAdapter({ token: bot.appSecret, transport })
          const result = await sender.text({ chatId: recipient, chatType: target.chatType },
            text, { signal, authorize: async () => stillBound() })
          if (result.outcome !== 'accepted') throw new DesktopError('schedule_failed', 'Telegram 定时任务投递失败')
        } else if (target.platform === 'wechat') {
          const latest = await options.wechat()
          if (!latest || latest.appId !== bot.appId || latest.userId !== recipient)
            throw new DesktopError('conflict', '定时任务的微信投递授权已变化')
          const api = createILinkClient({ botToken: latest.appSecret, baseUrl: latest.baseUrl, transport })
          await api.sendText(recipient, text, latest.contextToken, signal)
        } else {
          const api = createFeishuBotApi(transport)
          const token = await api.tenantToken(bot.appId, bot.appSecret, signal)
          if (!await stillBound()) throw new DesktopError('conflict', '定时任务的飞书投递授权已变化')
          await api.sendText(group ? 'chat_id' : 'open_id', recipient, text, token, signal)
        }
      } finally {
        await transport.close()
      }
    },
  }
}

export function bindDesktopScheduledIm({ feishuPairing, qqPairing, wechatPairing, wechatReach, telegram, transport, readScheduledGroup }: {
  feishuPairing: { read: Parameters<typeof createDesktopScheduledIm>[0]['feishu'] }
  qqPairing: { read: Parameters<typeof createDesktopScheduledIm>[0]['qq'] }
  wechatPairing: Pick<ReturnType<typeof import('../im/connect/platforms/wechat/index.js').createDesktopWechatPairing>, 'read'>
  wechatReach: Pick<ReturnType<typeof import('../im/gateway/platforms/wechat/index.js').createDesktopWechatReach>, 'read'>
  telegram: Pick<ReturnType<typeof import('../im/gateway/platforms/telegram/index.js').createDesktopTelegramGateway>, 'readScheduledBot'>
  readScheduledGroup?(params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  transport: Parameters<typeof createDesktopScheduledIm>[0]['transport']
}) {
  const scheduledIm = createDesktopScheduledIm({
    feishu: () => feishuPairing.read(), qq: () => qqPairing.read(), transport,
    async wechat() {
      const bot = await wechatPairing.read()
      if (!bot?.enabled) return null
      const reach = await wechatReach.read()
      if (!reach || reach.revision !== bot.revision) return null
      return { appId: bot.botId, appSecret: bot.token, userId: bot.userId, enabled: true,
        baseUrl: bot.baseUrl, contextToken: reach.contextToken }
    },
    async telegram() {
      const bot = await telegram.readScheduledBot()
      if (!bot) return null
      return {
        appId: bot.token.split(':', 1)[0]!, appSecret: bot.token, userId: bot.chatId, enabled: bot.enabled,
        groupChatEnabled: bot.groupChatEnabled, groupMemoryEnabled: bot.groupMemoryEnabled,
        groupHistorySearchEnabled: userBotGroupToolFlags(bot.groupAllowedTools).groupHistorySearchEnabled,
      }
    },
  })
  return async (method: string, params: Record<string, unknown>, signal: AbortSignal) => {
    if (method === 'agent.schedules.im.privateTarget' && (params.platform === 'qq' || params.platform === 'feishu'
      || params.platform === 'telegram' || params.platform === 'wechat')) return scheduledIm.privateTarget(params.platform)
    if (method === 'agent.schedules.im.groupCatalog') return null
    if (method === 'agent.schedules.im.decodeGroup') return await readScheduledGroup?.(params, signal) ?? null
    if (method === 'agent.schedules.im.authorize') return scheduledIm.authorize(params.target)
    if (method === 'agent.schedules.im.deliver' && typeof params.text === 'string' && params.text.length <= 8_192) {
      await scheduledIm.deliver(params.target, params.text, signal)
      return null
    }
    throw new DesktopError('invalid_request', '定时任务宿主能力无效')
  }
}
