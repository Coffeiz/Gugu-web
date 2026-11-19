import type { ProviderTransport } from '@gugu/core/providers'
import { createTelegramBotApi } from './client.js'
import { connectTelegramPolling, type TelegramPollingOptions } from './polling.js'
import { createTelegramSender } from './sender.js'

export * from './client.js'
export * from './polling.js'
export * from './sender.js'

export function createTelegramAdapter(options: { token: string; transport?: ProviderTransport }) {
  const { token } = options
  const api = createTelegramBotApi({ transport: options.transport })
  return {
    api,
    sender: createTelegramSender({ token, api }),
    connect: (options: Omit<TelegramPollingOptions, 'api' | 'token'>) =>
      connectTelegramPolling({ ...options, api, token }),
  }
}
