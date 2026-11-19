import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { ProviderTransport } from '@gugu/core/providers'
import { expect, test, vi } from 'vitest'
import { startDesktopTelegram } from '../src/gateway/telegram.js'

test('桌面 Telegram 重启后保留未确认消息并从 SQLite 游标续拉', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-gateway-'))
  const offsets: unknown[] = []
  const sent: unknown[] = []
  function transport(deliver: boolean): ProviderTransport {
    return {
      async request(request, signal) {
        const method = new URL(request.url).pathname.split('/').at(-1)
        let result: unknown
        switch (method) {
          case 'getMe': result = { id: 123456 }; break
          case 'getWebhookInfo': result = { url: '' }; break
          case 'getUpdates': {
            const { offset } = JSON.parse(Buffer.from(request.body as Uint8Array).toString())
            offsets.push(offset)
            if (!deliver) await setTimeout(60_000, undefined, { signal })
            deliver = false
            result = [{ update_id: 11, message: {
              message_id: 9, date: 100, chat: { id: 8, type: 'private' },
              from: { id: 8, first_name: '小北' }, text: '合成消息',
            } }]
            break
          }
          case 'sendMessage':
            sent.push(JSON.parse(Buffer.from(request.body as Uint8Array).toString()))
            result = { message_id: 12 }
            break
          default: throw new Error('未预期的测试请求')
        }
        return {
          status: 200, headers: {}, cancel() {},
          body: (async function* () { yield Buffer.from(JSON.stringify({ ok: true, result })) })(),
        }
      },
    }
  }
  const options = {
    botId: '7', ownerId: 'desktop-test', token: '123456:synthetic_Telegram_Token_0000',
    databasePath: join(directory, 'inbox.sqlite'),
    signal: new AbortController().signal,
    preflight: async () => 'enqueue' as const,
    callback: async () => false,
  }
  try {
    const first = await startDesktopTelegram({ ...options, transport: transport(true) })
    try {
      await vi.waitFor(() => expect(first.peek()?.payload.text).toBe('合成消息'))
    } finally { await first.stop() }
    const restarted = await startDesktopTelegram({ ...options, transport: transport(false) })
    try {
      expect(restarted.peek()?.updateId).toBe(11)
      await vi.waitFor(() => expect(offsets).toEqual([undefined, 12, 12]))
      const receipt = await restarted.sender.text({ chatId: '8', chatType: 'c2c' }, '合成回复', {
        authorize: async () => true,
      })
      expect(receipt.outcome).toBe('accepted')
      expect(sent).toEqual([expect.objectContaining({ chat_id: '8', text: '合成回复' })])
      restarted.acknowledge(11)
      expect(restarted.peek()).toBeNull()
    } finally { await restarted.stop() }
    const text = await readFile(join(directory, 'logs', 'gugu.log'), 'utf8')
    expect(text.trim().split('\n').map(line => JSON.parse(line).event)).toEqual([
      'gateway.started', 'gateway.stopped', 'gateway.started', 'gateway.stopped',
    ])
    expect(text).not.toMatch(/synthetic_Telegram|合成消息|desktop-test/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
