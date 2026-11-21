import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDesktopWechatPairing } from '../src/main/im/connect/platforms/wechat/index.js'

it('微信扫码替换旧任务，确认后仅通过加密存储保留凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-wechat-'))
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
    async request(request: { url: string }) {
      const value = request.url.includes('get_qrcode_status')
        ? { status: 'confirmed', bot_token: 'synthetic-token', ilink_bot_id: 'bot', ilink_user_id: 'scanner', baseurl: 'https://example.com' }
        : { qrcode: 'synthetic-code', qrcode_img_content: 'https://example.com/scan' }
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(value)) })(), cancel() {} }
    },
  }
  try {
    const pairing = createDesktopWechatPairing(directory, encryption, owner, transport)
    const old = await pairing.start()
    const active = await pairing.start()
    expect(await pairing.poll(old.task_id)).toEqual({ status: 'expired' })
    expect(await pairing.poll(active.task_id)).toEqual({ status: 'success', bot: { id: 1, name: '我的微信' } })
    expect(await pairing.poll(active.task_id)).toEqual({ status: 'expired' })
    expect(await pairing.status()).toEqual({ configured: true, enabled: true, detail: 'https://example.com' })
    const waiting = await pairing.start()
    expect(await pairing.setEnabled(false)).toEqual({ configured: true, enabled: false, detail: 'https://example.com' })
    expect(await pairing.poll(waiting.task_id)).toEqual({ status: 'expired' })
    const reopened = createDesktopWechatPairing(directory, encryption, owner, transport)
    expect(await reopened.status()).toEqual({ configured: true, enabled: false, detail: 'https://example.com' })
    expect(await reopened.setEnabled(true)).toEqual({ configured: true, enabled: true, detail: 'https://example.com' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
