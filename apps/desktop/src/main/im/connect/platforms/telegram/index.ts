import { validateTelegramBotToken } from '@gugu/gateway/telegram'
import type { ImGroupAttentionMode, ImGroupReplyMode } from '@gugu/core/im/group-settings'
import { defaultUserBotGroupSettings, defaultUserBotPrivateStreamingEnabled } from '@gugu/core/im/user-bots'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'
import { DesktopError } from '../../../../core-host.js'

export type DesktopTelegramEncryption = Parameters<typeof createEncryptedDesktopStore>[2]
export type DesktopTelegramBot = { token: string; chatId: string | null; enabled: boolean; revision: string
  privateStreamingEnabled: boolean
  groupChatEnabled: boolean; groupReplyMode: ImGroupReplyMode
  groupAttentionMode: ImGroupAttentionMode; groupAllowedTools: string[]
  groupOwnerMemoryEnabled: boolean; groupMemoryEnabled: boolean; memberMemoryEnabled: boolean }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const validTelegramPrivateId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)

export function parseDesktopTelegramBot(value: unknown): DesktopTelegramBot {
  if (!isRecord(value) || (value.chatId !== null && !validTelegramPrivateId(value.chatId)) || typeof value.token !== 'string'
      || typeof value.enabled !== 'boolean' || typeof value.revision !== 'string')
    throw new DesktopError('invalid_request', 'Telegram 连接配置无效')
  const defaults = defaultUserBotGroupSettings('telegram')
  const groupChatEnabled = value.groupChatEnabled ?? defaults.groupChatEnabled
  const groupReplyMode = value.groupReplyMode ?? defaults.groupReplyMode
  const groupAttentionMode = value.groupAttentionMode ?? defaults.groupAttentionMode
  const groupAllowedTools = value.groupAllowedTools ?? defaults.groupAllowedTools
  const groupOwnerMemoryEnabled = value.groupOwnerMemoryEnabled ?? defaults.groupOwnerMemoryEnabled
  const groupMemoryEnabled = value.groupMemoryEnabled ?? defaults.groupMemoryEnabled
  const memberMemoryEnabled = value.memberMemoryEnabled ?? defaults.memberMemoryEnabled
  const privateStreamingEnabled = value.privateStreamingEnabled ?? defaultUserBotPrivateStreamingEnabled('telegram')
  if (typeof groupChatEnabled !== 'boolean' || !['reply_mentions', 'reply_all', 'record_only'].includes(String(groupReplyMode))
    || !['quiet', 'natural', 'active', 'autonomous'].includes(String(groupAttentionMode))
    || !Array.isArray(groupAllowedTools) || !groupAllowedTools.every(tool => typeof tool === 'string'
      && ['web_search', 'http_get', 'similar_image_search', 'send_item', 'group_context_search'].includes(tool))
    || typeof groupOwnerMemoryEnabled !== 'boolean' || typeof groupMemoryEnabled !== 'boolean' || typeof memberMemoryEnabled !== 'boolean'
    || typeof privateStreamingEnabled !== 'boolean')
    throw new DesktopError('invalid_request', 'Telegram 群聊设置无效')
  let token: string
  try { token = validateTelegramBotToken(value.token) } catch {
    throw new DesktopError('invalid_request', 'Telegram Bot Token 格式无效')
  }
  return { token, chatId: value.chatId, enabled: value.enabled, revision: value.revision,
    groupChatEnabled, groupReplyMode: groupReplyMode as DesktopTelegramBot['groupReplyMode'],
    groupAttentionMode: groupAttentionMode as DesktopTelegramBot['groupAttentionMode'], groupAllowedTools,
    groupOwnerMemoryEnabled, groupMemoryEnabled, memberMemoryEnabled, privateStreamingEnabled }
}

export function createDesktopTelegramConfig(directory: string, encryption: DesktopTelegramEncryption) {
  return createEncryptedDesktopStore(directory, 'im-telegram', encryption, parseDesktopTelegramBot)
}
