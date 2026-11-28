import assert from 'node:assert/strict'
import { test } from 'vitest'
import { resolveImActor } from '../../src/im/access.js'
import { createImMemoryContextSource, imMemoryScopeFileKey, type ImMemoryScopeFile } from '../../src/im/memory-source.js'

const identity = { ownerId: 'owner-synthetic', sessionId: '12', runId: 'run-synthetic' }
const actor = resolveImActor({ ownerId: identity.ownerId, botId: '7', platform: 'qq', platformUserId: 'member-synthetic',
  chatType: 'group', chatId: 'group-synthetic', botMentioned: true, mentionsOtherBot: false },
() => ({ role: 'member', allowedToolNames: [] }))
const groupScope: ImMemoryScopeFile = { owner_user_id: identity.ownerId, platform: 'qq', bot_id: '7', scope_type: 'group', scope_id: 'group-synthetic' }

function source(options: { memberEnabled?: boolean; groupEnabled?: boolean; tombstone?: boolean; revokeAfterRead?: boolean } = {}) {
  const files = new Map([
    [imMemoryScopeFileKey(groupScope, 'summary.json'), JSON.stringify({ text: '本群决定' })],
    [imMemoryScopeFileKey(groupScope, 'profile.json'), JSON.stringify({ text: '产品讨论群' })],
    [imMemoryScopeFileKey({ ...groupScope, scope_type: 'platform-user', scope_id: 'group-synthetic:member-synthetic' }, 'profile.json'), JSON.stringify({ text: '成员偏好' })],
  ])
  let reads = 0
  const data = createImMemoryContextSource({ identity, actor,
    async authorize() {
      return { ownerId: identity.ownerId, botId: actor.botId, platform: actor.platform, chatType: actor.chatType,
        chatId: actor.chatId, platformUserId: actor.platformUserId, groupMemoryEnabled: options.groupEnabled !== false,
        memberMemoryEnabled: options.memberEnabled !== false && !(options.revokeAfterRead && reads > 0),
        groupOwnerMemoryEnabled: false }
    },
    async readText(scope, filename) { reads++; return files.get(imMemoryScopeFileKey(scope, filename)) ?? null },
    async isTombstoned() { return options.tombstone === true },
  })
  return { data, reads: () => reads }
}

test('Core IM memory loader只读取当前群公开字段和当前成员字段', async () => {
  const value = source()
  const result = await value.data.loadImMemory(identity)
  assert.deepEqual(result, { group: { summary: { text: '本群决定' }, profile: { text: '产品讨论群' } },
    platform_user: { summary: {}, profile: { text: '成员偏好' }, pattern: {} } })
  assert.equal(value.reads(), 5)
  assert.throws(() => imMemoryScopeFileKey({ ...groupScope, scope_id: '../outside' }, 'summary.json'))
  assert.ok(imMemoryScopeFileKey(groupScope, 'memory.md').endsWith('/memory.md'))
})

test('Core IM memory loader respects per-scope switches and tombstones', async () => {
  assert.deepEqual(await source({ groupEnabled: false }).data.loadImMemory(identity),
    { platform_user: { summary: {}, profile: { text: '成员偏好' }, pattern: {} } })
  assert.deepEqual(await source({ memberEnabled: false }).data.loadImMemory(identity),
    { group: { summary: { text: '本群决定' }, profile: { text: '产品讨论群' } } })
  assert.deepEqual(await source({ tombstone: true }).data.loadImMemory(identity), {})
})

test('Core IM memory loader拒绝scope身份不匹配与读取期间撤权', async () => {
  const value = source({ revokeAfterRead: true })
  await assert.rejects(value.data.loadImMemory({ ...identity, sessionId: '13' }), /IM 记忆读取不可用/u)
  await assert.rejects(value.data.loadImMemory(identity), /IM 记忆读取不可用/u)
})
