import { validateTelegramBotToken } from '@gugu/gateway/telegram'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'
import { DesktopError } from '../../../../core-host.js'

export type DesktopTelegramEncryption = Parameters<typeof createEncryptedDesktopStore>[2]
export type DesktopTelegramBot = { token: string; chatId: string | null; enabled: boolean; revision: string }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const validTelegramPrivateId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)

export function parseDesktopTelegramBot(value: unknown): DesktopTelegramBot {
  if (!isRecord(value) || (value.chatId !== null && !validTelegramPrivateId(value.chatId)) || typeof value.token !== 'string'
      || typeof value.enabled !== 'boolean' || typeof value.revision !== 'string')
    throw new DesktopError('invalid_request', 'Telegram 连接配置无效')
  try {
    return { token: validateTelegramBotToken(value.token), chatId: value.chatId, enabled: value.enabled, revision: value.revision }
  } catch {
    throw new DesktopError('invalid_request', 'Telegram Bot Token 格式无效')
  }
}

export function createDesktopTelegramConfig(directory: string, encryption: DesktopTelegramEncryption) {
  return createEncryptedDesktopStore(directory, 'im-telegram', encryption, parseDesktopTelegramBot)
}
