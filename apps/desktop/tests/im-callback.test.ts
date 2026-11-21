import { telegramPrivateInteraction } from '../../../packages/gateway/tests/fixtures/telegram-private-interaction.js'
import { qqPrivateInteraction } from '../../../packages/gateway/tests/fixtures/qq-private-interaction.js'
import { expect, it, vi } from 'vitest'
import { createDesktopImCallback } from '../src/main/im/gateway/interactions/callback.js'
import type { IpcHost } from '../src/main/ipc/types.js'

it('仅将匹配已投递提示和绑定用户的 Telegram 回调提交给原运行', async () => {
  const connection = { platform: 'telegram', ownerId: 'desktop', botId: '1' } as const
  const config = { model: 'synthetic' } as Awaited<ReturnType<Parameters<typeof createDesktopImCallback>[1]['resolveRunModel']>>
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prompt') return params?.messageId === String(telegramPrivateInteraction.message.message_id) ? { sessionId: 8, runId: 'run' } : null
    if (method === 'agent.sessions.runModel') return null
    return {}
  })
  const callback = createDesktopImCallback({ request: request as IpcHost['request'] }, { resolveRunModel: async () => config })
  const payload = telegramPrivateInteraction
  const user = String(payload.from.id)
  const scope = 'a'.repeat(64)
  expect(await callback(connection, scope, '8', payload, async () => true)).toBe(false)
  expect(await callback(connection, scope, user, { ...payload, message: { ...payload.message, message_id: 10 } }, async () => true)).toBe(false)
  expect(await callback(connection, scope, user, payload, async () => true)).toBe(true)
  expect(request.mock.calls.filter(([method]) => method === 'agent.sessions.respond')).toEqual([
    ['agent.sessions.respond', expect.objectContaining({ id: 8, runId: 'run', promptId: 7, token: 'synthetic-action' })],
  ])
})

it('QQ 无消息 ID 回调仍需绑定用户和已投递的提示', async () => {
  const connection = { platform: 'qq', ownerId: 'desktop', botId: 'app' } as const
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) =>
    method === 'im.inbox.prompt' && params?.promptId === 7 ? { sessionId: 8, runId: 'run' } : null)
  const config = { model: 'synthetic' } as Awaited<ReturnType<Parameters<typeof createDesktopImCallback>[1]['resolveRunModel']>>
  const callback = createDesktopImCallback({ request: request as IpcHost['request'] }, { resolveRunModel: async () => config })
  const payload = qqPrivateInteraction
  const user = payload.user_openid
  const scope = 'a'.repeat(64)
  expect(await callback(connection, scope, user, { ...payload, user_openid: 'other' }, async () => true)).toBe(false)
  expect(await callback(connection, scope, user, { ...payload, data: { resolved: { button_data: '8:synthetic-action' } } }, async () => true)).toBe(false)
  expect(await callback(connection, scope, user, payload, async () => true)).toBe(true)
  expect(request.mock.calls.filter(([method]) => method === 'agent.sessions.respond')).toEqual([
    ['agent.sessions.respond', expect.objectContaining({ id: 8, runId: 'run', promptId: 7, token: 'synthetic-action' })],
  ])
  expect(request).toHaveBeenCalledWith('im.inbox.prompt', expect.objectContaining({ platform: 'qq', messageId: null, promptId: 7 }))
})
