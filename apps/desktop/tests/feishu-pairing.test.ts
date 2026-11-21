import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDesktopFeishuPairing } from '../src/main/im/connect/platforms/feishu/index.js'

it('飞书扫码替换旧任务，确认后仅通过加密存储保留凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-feishu-'))
  const owner = randomUUID()
  const sealed = new Map<string, string>()
  const encryption = {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(value: string) {
      const id = randomUUID()
      sealed.set(id, value)
      return Buffer.from(id)
    },
    async decryptStringAsync(value: Buffer) {
      return { result: sealed.get(value.toString())!, shouldReEncrypt: false }
    },
  }
  const transport = {
    async request(request: { body?: Uint8Array | string }) {
      const action = new URLSearchParams(Buffer.from(request.body ?? '').toString()).get('action')
      const value = action === 'init' ? { supported_auth_methods: ['client_secret'] }
        : action === 'begin' ? { device_code: 'synthetic-code', verification_uri_complete: 'https://example.com/scan' }
          : { client_id: 'app', client_secret: 'synthetic-secret', user_info: { open_id: 'scanner' } }
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(value)) })(), cancel() {} }
    },
  }
  try {
    const pairing = createDesktopFeishuPairing(directory, encryption, owner, transport)
    const old = await pairing.start()
    const active = await pairing.start()
    expect(await pairing.poll(old.poll_id)).toEqual({ status: 'expired' })
    expect(await pairing.poll(active.poll_id)).toEqual({ status: 'success', bot: { id: 1, name: '我的飞书', app_id: 'app' } })
    expect(await pairing.poll(active.poll_id)).toEqual({ status: 'expired' })
    expect(await pairing.status()).toMatchObject({ configured: true, enabled: true, bound: true,
      groupChatEnabled: true, groupReplyMode: 'reply_mentions', groupAttentionMode: 'autonomous' })
    await pairing.updateGroupSettings({ groupReplyMode: 'reply_all', groupAttentionMode: 'active',
      groupOwnerMemoryEnabled: true, groupHistorySearchEnabled: true })
    const waiting = await pairing.start()
    expect(await pairing.setEnabled(false)).toMatchObject({ configured: true, enabled: false })
    expect(await pairing.poll(waiting.poll_id)).toEqual({ status: 'expired' })
    const reopened = createDesktopFeishuPairing(directory, encryption, owner, transport)
    expect(await reopened.status()).toMatchObject({ configured: true, enabled: false,
      groupReplyMode: 'reply_all', groupAttentionMode: 'active', groupOwnerMemoryEnabled: true, groupHistorySearchEnabled: true })
    expect(await reopened.setEnabled(true)).toMatchObject({ configured: true, enabled: true })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
