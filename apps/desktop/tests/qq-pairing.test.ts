import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDesktopQqPairing } from '../src/main/im/connect/platforms/qq/index.js'

it('QQ 扫码替换旧任务，保存凭据后无需等待网关重连即可返回成功', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-qq-'))
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
  let key = Buffer.alloc(0)
  let tasks = 0
  let userOpenId: string | undefined
  const transport = {
    async request(request: { url: string; body?: unknown }) {
      let value: unknown
      if (request.url.endsWith('create_bind_task')) {
        key = Buffer.from((request.body as { key: string }).key, 'base64')
        value = { retcode: 0, data: { task_id: `synthetic-task-${++tasks}` } }
      } else {
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        const secret = Buffer.concat([iv, cipher.update('synthetic-secret'), cipher.final(), cipher.getAuthTag()])
        value = { retcode: 0, data: { status: 2, bot_appid: 'app', bot_encrypt_secret: secret.toString('base64'), user_openid: userOpenId } }
      }
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(value)) })(), cancel() {} }
    },
  }
  const reconnect = Promise.withResolvers<void>()
  let applyCount = 0
  try {
    const pairing = createDesktopQqPairing(directory, encryption, owner, transport, () => {
      applyCount++
      return reconnect.promise
    })
    const old = await pairing.start()
    const active = await pairing.start()
    expect(await pairing.poll(old.task_id)).toEqual({ status: 'expired' })
    expect(await pairing.poll(active.task_id)).toEqual({ status: 'success', bot: { id: 1, name: '我的QQ', app_id: 'app' } })
    expect(applyCount).toBe(1)
    expect(await pairing.poll(active.task_id)).toEqual({ status: 'expired' })
    expect(await pairing.status()).toEqual({ configured: true, enabled: true, bound: false, privateMessageFormat: 'markdown', groupMessageFormat: 'compat', privateStreamingEnabled: true, groupChatEnabled: false, groupReplyMode: 'reply_mentions', groupHistorySearchEnabled: false, groupWebToolsEnabled: false, groupProviderSearchEnabled: false, groupOwnerMemoryEnabled: false, groupMemoryEnabled: true, memberMemoryEnabled: true })
    await expect(pairing.setGroupOwnerMemory(true)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(pairing.setGroupMemory(false)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(pairing.setMemberMemory(false)).rejects.toMatchObject({ code: 'invalid_request' })
    const current = await pairing.read()
    if (!current) throw new Error('缺少扫码凭据')
    const { code } = await pairing.issueBinding()
    const actor = { appId: current.appId, revision: current.revision, userId: 'qq-user', eventId: 'binding-message', chatType: 'c2c' } as const
    expect(await pairing.consumeBinding({ ...actor, chatType: 'group' }, code)).toBe(false)
    expect(await pairing.consumeBinding({ ...actor, revision: 'other' }, code)).toBe(false)
    const wrong = code === '000000' ? '000001' : '000000'
    for (let attempt = 0; attempt < 5; attempt++) expect(await pairing.consumeBinding(actor, wrong)).toBe(false)
    expect(await pairing.consumeBinding(actor, code)).toBe(false)
    const replacement = await pairing.issueBinding()
    expect(await pairing.consumeBinding(actor, replacement.code)).toBe(true)
    expect(await pairing.consumeBinding({ ...actor, userId: 'other' }, replacement.code)).toBe(false)
    expect(await pairing.read()).toMatchObject({ userId: actor.userId })
    const waiting = await pairing.start()
    expect(await pairing.setEnabled(false)).toEqual({ configured: true, enabled: false, bound: true, privateMessageFormat: 'markdown', groupMessageFormat: 'compat', privateStreamingEnabled: true, groupChatEnabled: false, groupReplyMode: 'reply_mentions', groupHistorySearchEnabled: false, groupWebToolsEnabled: false, groupProviderSearchEnabled: false, groupOwnerMemoryEnabled: false, groupMemoryEnabled: true, memberMemoryEnabled: true })
    expect(await pairing.poll(waiting.task_id)).toEqual({ status: 'expired' })
    const reopened = createDesktopQqPairing(directory, encryption, owner, transport)
    expect(await reopened.status()).toEqual({ configured: true, enabled: false, bound: true, privateMessageFormat: 'markdown', groupMessageFormat: 'compat', privateStreamingEnabled: true, groupChatEnabled: false, groupReplyMode: 'reply_mentions', groupHistorySearchEnabled: false, groupWebToolsEnabled: false, groupProviderSearchEnabled: false, groupOwnerMemoryEnabled: false, groupMemoryEnabled: true, memberMemoryEnabled: true })
    expect(await reopened.setEnabled(true)).toEqual({ configured: true, enabled: true, bound: true, privateMessageFormat: 'markdown', groupMessageFormat: 'compat', privateStreamingEnabled: true, groupChatEnabled: false, groupReplyMode: 'reply_mentions', groupHistorySearchEnabled: false, groupWebToolsEnabled: false, groupProviderSearchEnabled: false, groupOwnerMemoryEnabled: false, groupMemoryEnabled: true, memberMemoryEnabled: true })
    userOpenId = 'synthetic-scan-owner'
    const authorized = await reopened.start()
    expect(await reopened.poll(authorized.task_id)).toMatchObject({ status: 'success' })
    expect(await reopened.status()).toEqual({ configured: true, enabled: true, bound: true, privateMessageFormat: 'markdown', groupMessageFormat: 'compat', privateStreamingEnabled: true, groupChatEnabled: false, groupReplyMode: 'reply_mentions', groupHistorySearchEnabled: false, groupWebToolsEnabled: false, groupProviderSearchEnabled: false, groupOwnerMemoryEnabled: false, groupMemoryEnabled: true, memberMemoryEnabled: true })
    expect(await reopened.read()).toMatchObject({ userId: userOpenId, bindingEventId: null })
    expect(await reopened.setGroupReplyMode('reply_all')).toMatchObject({ groupReplyMode: 'reply_all' })
    expect(await reopened.setGroupReplyMode('reply_mentions')).toMatchObject({ groupReplyMode: 'reply_mentions' })
    expect(await reopened.setGroupChat(true)).toMatchObject({ groupChatEnabled: true })
    expect(await reopened.setGroupWebTools(true)).toMatchObject({ groupWebToolsEnabled: true })
    expect(await reopened.setGroupProviderSearch(true)).toMatchObject({ groupProviderSearchEnabled: true })
    const toolSettings = createDesktopQqPairing(directory, encryption, owner, transport)
    expect(await toolSettings.status()).toMatchObject({ groupWebToolsEnabled: true, groupProviderSearchEnabled: true })
    expect(await toolSettings.setGroupWebTools(false)).toMatchObject({ groupWebToolsEnabled: false, groupProviderSearchEnabled: true })
    expect(await reopened.setGroupChat(false)).toMatchObject({ groupChatEnabled: false, groupReplyMode: 'reply_mentions', groupHistorySearchEnabled: false, groupWebToolsEnabled: false, groupProviderSearchEnabled: true })
    expect(await reopened.setGroupChat(true)).toMatchObject({ groupChatEnabled: true })
    expect(await reopened.setGroupOwnerMemory(true)).toMatchObject({ groupOwnerMemoryEnabled: true })
    expect(await reopened.setGroupMemory(false)).toMatchObject({ groupMemoryEnabled: false })
    expect(await reopened.setMemberMemory(false)).toMatchObject({ memberMemoryEnabled: false })
    const memorySettings = createDesktopQqPairing(directory, encryption, owner, transport)
    expect(await memorySettings.status()).toMatchObject({ groupOwnerMemoryEnabled: true, groupMemoryEnabled: false, memberMemoryEnabled: false })
    expect(await reopened.setPrivateStreaming(true)).toMatchObject({ privateStreamingEnabled: true })
    expect(await reopened.setPrivateMessageFormat('compat')).toMatchObject({ privateStreamingEnabled: false })
    await expect(reopened.setPrivateStreaming(true)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(await reopened.setGroupMessageFormat('markdown')).toMatchObject({ groupMessageFormat: 'markdown', privateMessageFormat: 'compat' })
    expect(await reopened.unbind()).toMatchObject({ bound: false, privateMessageFormat: 'compat' })
    const afterUnbind = createDesktopQqPairing(directory, encryption, owner, transport)
    expect(await afterUnbind.status()).toMatchObject({ bound: false, privateMessageFormat: 'compat' })
  } finally {
    reconnect.resolve()
    await rm(directory, { recursive: true, force: true })
  }
})
