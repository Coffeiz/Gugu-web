import { userBotGroupToolFlags } from '@gugu/core/im/user-bots'
import { createFeishuBotApi } from '@gugu/core/im/feishu-bot-api'
import { createILinkClient } from '@gugu/gateway/wechat'
import { createTelegramAdapter } from '@gugu/gateway/telegram'
import { createQqBotApi } from '@gugu/core/im/qq-bot-api'
import type { ProviderTransport } from '@gugu/core/providers'
import { desktopScheduleImTarget, type DesktopScheduleImPlatform, type DesktopScheduleImTarget } from '../../../../../packages/core/src/scheduled-tasks/desktop-im.js'
import { DesktopError } from '../core-host.js'

type Bot = { appId: string; appSecret: string; enabled: boolean; userId: string | null;
  groupChatEnabled?: boolean; groupMemoryEnabled?: boolean; groupHistorySearchEnabled?: boolean }

export function createDesktopScheduledIm(options: {
  feishu(): Promise<Bot | null | undefined>
  qq(): Promise<Bot | null | undefined>
  telegram(): Promise<Bot | null | undefined>
  wechat(): Promise<(Bot & { baseUrl: string; contextToken: string }) | null>
  transport(): ProviderTransport & { close(): Promise<void> }
}) {
  async function active(target: DesktopScheduleImTarget) {
    const bot = await options[target.platform]()
    return bot?.enabled && bot.appId === target.botId && bot.userId === target.boundUserId
      && (target.chatType === 'group' ? bot.groupChatEnabled : bot.userId === target.recipient) ? bot : null
  }

  return {
    async privateTarget(platform: DesktopScheduleImPlatform) {
      const bot = await options[platform]()
      return bot?.enabled && bot.userId
        ? desktopScheduleImTarget.parse({ platform, botId: bot.appId, boundUserId: bot.userId, chatType: 'c2c', recipient: bot.userId })
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
      try {
        if (target.platform === 'qq') {
          const api = createQqBotApi(transport)
          const token = await api.token(bot.appId, bot.appSecret, signal)
          if (!token || !await active(target)
            || !await api.sendText({ recipient: target.recipient, group, sandbox: false }, text, token, signal))
            throw new DesktopError('schedule_failed', 'QQ 定时任务投递失败')
        } else if (target.platform === 'telegram') {
          const { sender } = createTelegramAdapter({ token: bot.appSecret, transport })
          const result = await sender.text({ chatId: target.recipient, chatType: target.chatType },
            text, { signal, authorize: async () => Boolean(await active(target)) })
          if (result.outcome !== 'accepted') throw new DesktopError('schedule_failed', 'Telegram 定时任务投递失败')
        } else if (target.platform === 'wechat') {
          const latest = await options.wechat()
          if (!latest || latest.appId !== bot.appId || latest.userId !== target.recipient)
            throw new DesktopError('conflict', '定时任务的微信投递授权已变化')
          const api = createILinkClient({ botToken: latest.appSecret, baseUrl: latest.baseUrl, transport })
          await api.sendText(target.recipient, text, latest.contextToken, signal)
        } else {
          const api = createFeishuBotApi(transport)
          const token = await api.tenantToken(bot.appId, bot.appSecret, signal)
          if (!await active(target)) throw new DesktopError('conflict', '定时任务的飞书投递授权已变化')
          await api.sendText(group ? 'chat_id' : 'open_id', target.recipient, text, token, signal)
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
