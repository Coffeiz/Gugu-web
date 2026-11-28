import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDesktopImPendingAskStore } from '../src/main/im/gateway/inbound/pending-asks.js'

it('群消息活动会使旧延迟唤醒失效，并在安静窗口后从加密存储恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-pending-'))
  let now = 1_000
  const encryption = {
    isAsyncEncryptionAvailable: async () => true,
    async encryptStringAsync(value: string) { return Buffer.from(value) },
    async decryptStringAsync(value: Buffer) { return { result: value.toString(), shouldReEncrypt: false } },
  }
  const scope = { ownerId: 'desktop', botId: 'app_test', platform: 'feishu' as const, groupId: 'group_test' }
  const trigger = { eventId: 'event_1', eventMs: now, platformMessageId: 'message_1', senderId: 'member_1',
    payload: { eventKey: 'a'.repeat(64) } }
  try {
    const store = createDesktopImPendingAskStore(directory, encryption, () => now)
    const resumeId = await store.register(scope, trigger)
    if (!resumeId) throw new Error('延迟唤醒未登记')
    now = 62_000
    const claimed = await store.claimDue()
    expect(claimed).toHaveLength(1)
    await store.observe(scope, { eventMs: now, senderId: 'member_2' })
    expect(await store.isCurrent(claimed[0]!)).toBe(false)
    expect(await store.claimDue()).toEqual([])

    now = 92_000
    const recovered = createDesktopImPendingAskStore(directory, encryption, () => now)
    const due = await recovered.claimDue()
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({ scope, trigger, latestAskMs: 1_000 })
    expect(due[0]!.resumeId).not.toBe(resumeId)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('群内直接提及会取消尚未唤醒的 ASK', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-pending-'))
  let now = 1_000
  const encryption = {
    isAsyncEncryptionAvailable: async () => true,
    async encryptStringAsync(value: string) { return Buffer.from(value) },
    async decryptStringAsync(value: Buffer) { return { result: value.toString(), shouldReEncrypt: false } },
  }
  try {
    const store = createDesktopImPendingAskStore(directory, encryption, () => now)
    const scope = { ownerId: 'desktop', botId: 'bot_test', platform: 'telegram' as const, groupId: 'group_test' }
    const trigger = { eventId: 'event_1', eventMs: 1_000, platformMessageId: 'message_1', senderId: 'member_1', payload: {} }
    await store.register(scope, trigger)
    await store.observe(scope, { eventMs: 2_000, senderId: 'member_2', ownBotId: 'bot_test', directMention: true })
    now = 62_000
    expect(await store.claimDue()).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('群内直接提及先于 ASK 登记到达时，会拒绝已过期的 ASK', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-pending-'))
  const encryption = {
    isAsyncEncryptionAvailable: async () => true,
    async encryptStringAsync(value: string) { return Buffer.from(value) },
    async decryptStringAsync(value: Buffer) { return { result: value.toString(), shouldReEncrypt: false } },
  }
  try {
    const store = createDesktopImPendingAskStore(directory, encryption, () => 10_000)
    const scope = { ownerId: 'desktop', botId: 'bot_test', platform: 'feishu' as const, groupId: 'group_test' }
    await store.observe(scope, { eventMs: 2_000, senderId: 'member_2', directMention: true })
    expect(await store.register(scope, { eventId: 'stale', eventMs: 1_500,
      platformMessageId: 'message_stale', senderId: 'member_1', payload: {} })).toBeNull()
    expect(await store.register(scope, { eventId: 'newer', eventMs: 3_000,
      platformMessageId: 'message_newer', senderId: 'member_1', payload: {} })).toBeTruthy()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
