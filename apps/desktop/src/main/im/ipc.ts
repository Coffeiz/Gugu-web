import { FeishuConnectionError } from '@gugu/gateway/feishu'
import { QqConnectionError } from '@gugu/gateway/qq'
import { WechatConnectionError } from '@gugu/gateway/wechat'
import { DESKTOP_CHANNELS, type DesktopImConnectionState } from '@gugu/core/desktop'
import type { createDesktopQqPairing } from './connect/platforms/qq/index.js'
import type { createDesktopWechatPairing } from './connect/platforms/wechat/index.js'
import type { createDesktopFeishuPairing } from './connect/platforms/feishu/index.js'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers } from '../ipc/types.js'
import type { createDesktopTelegramGateway } from './gateway/platforms/telegram/index.js'

export function telegramHandlers(gateway: ReturnType<typeof createDesktopTelegramGateway>): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.telegramGateway]: async command => {
      if (command && typeof command === 'object' && 'action' in command) {
        switch (command.action) {
          case 'status': return gateway.snapshot()
          case 'bindingCode': return gateway.bindingCode()
          case 'save': return gateway.save('input' in command ? command.input : null)
          case 'enable': return gateway.enable()
          case 'disable': return gateway.disable()
        }
      }
      throw new DesktopError('invalid_request', 'Telegram 网关操作无效')
    },
  }
}

export function pairingHandlers(platform: 'wechat' | 'feishu' | 'qq',
  pairing: ReturnType<typeof createDesktopWechatPairing> | ReturnType<typeof createDesktopFeishuPairing> | ReturnType<typeof createDesktopQqPairing>,
  health: () => { running: number; retrying: number; cleanupUnknown: number }): IpcHandlers {
  async function pair(action: () => Promise<unknown>): Promise<unknown> {
    try { return await action() } catch (error) {
      if (error instanceof FeishuConnectionError || error instanceof QqConnectionError || error instanceof WechatConnectionError)
        throw new DesktopError('im_pairing_failed', error.message)
      throw error
    }
  }

  function statusWithHealth(status: { configured: boolean; enabled: boolean; bound?: boolean; detail?: string }) {
    const current = health()
    const connectionState: DesktopImConnectionState = current.cleanupUnknown ? 'cleanup_failed'
      : !status.enabled ? 'disabled' : current.running ? 'running' : current.retrying ? 'retrying' : 'connecting'
    return { ...status, connectionState }
  }
  return {
    [DESKTOP_CHANNELS[`${platform}Pairing`]]: async command => {
      if (command && typeof command === 'object' && 'action' in command) {
        switch (command.action) {
          case 'status': return statusWithHealth(await pairing.status())
          case 'enable': return statusWithHealth(await pairing.setEnabled(true))
          case 'disable': return statusWithHealth(await pairing.setEnabled(false))
          case 'unbind':
            if ('unbind' in pairing) return statusWithHealth(await pairing.unbind())
            break
          case 'setGroupReplyMode':
            if ('setGroupReplyMode' in pairing && 'mode' in command && (command.mode === 'reply_mentions' || command.mode === 'reply_all' || command.mode === 'record_only'))
              return statusWithHealth(await pairing.setGroupReplyMode(command.mode))
            break
          case 'setGroupWebTools':
            if ('setGroupWebTools' in pairing && 'enabled' in command && typeof command.enabled === 'boolean')
              return statusWithHealth(await pairing.setGroupWebTools(command.enabled))
            break
          case 'setGroupProviderSearch':
            if ('setGroupProviderSearch' in pairing && 'enabled' in command && typeof command.enabled === 'boolean')
              return statusWithHealth(await pairing.setGroupProviderSearch(command.enabled))
            break
          case 'setGroupHistorySearch':
            if ('setGroupHistorySearch' in pairing && 'enabled' in command && typeof command.enabled === 'boolean')
              return statusWithHealth(await pairing.setGroupHistorySearch(command.enabled))
            break
          case 'setGroupOwnerMemory':
            if ('setGroupOwnerMemory' in pairing && 'enabled' in command && typeof command.enabled === 'boolean')
              return statusWithHealth(await pairing.setGroupOwnerMemory(command.enabled))
            break
          case 'setGroupMemory':
            if ('setGroupMemory' in pairing && 'enabled' in command && typeof command.enabled === 'boolean')
              return statusWithHealth(await pairing.setGroupMemory(command.enabled))
            break
          case 'setMemberMemory':
            if ('setMemberMemory' in pairing && 'enabled' in command && typeof command.enabled === 'boolean')
              return statusWithHealth(await pairing.setMemberMemory(command.enabled))
            break
          case 'setGroupChat':
            if ('setGroupChat' in pairing && 'enabled' in command && typeof command.enabled === 'boolean')
              return statusWithHealth(await pairing.setGroupChat(command.enabled))
            break
          case 'setPrivateStreaming':
            if ('setPrivateStreaming' in pairing && 'enabled' in command && typeof command.enabled === 'boolean')
              return statusWithHealth(await pairing.setPrivateStreaming(command.enabled))
            break
          case 'setGroupMessageFormat':
            if ('setGroupMessageFormat' in pairing && 'format' in command
              && (command.format === 'compat' || command.format === 'markdown'))
              return statusWithHealth(await pairing.setGroupMessageFormat(command.format))
            break
          case 'setPrivateMessageFormat':
            if ('setPrivateMessageFormat' in pairing && 'format' in command
              && (command.format === 'compat' || command.format === 'markdown'))
              return statusWithHealth(await pairing.setPrivateMessageFormat(command.format))
            break
          case 'bindingCode':
            if ('issueBinding' in pairing) return pairing.issueBinding()
            break
          case 'start': return pair(() => pairing.start())
          case 'poll':
            if ('taskId' in command && typeof command.taskId === 'string' && command.taskId.length <= 512 && command.taskId.length > 0)
              return pair(pairing.poll.bind(pairing, command.taskId))
        }
      }
      throw new DesktopError('invalid_request', '扫码操作无效')
    },
  }
}
