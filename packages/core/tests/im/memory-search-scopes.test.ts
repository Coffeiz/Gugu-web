import assert from 'node:assert/strict'
import { test } from 'vitest'
import { resolveImMemorySearchScopes } from '../../src/im/memory-search-scopes.js'
import type { ImActor } from '../../src/im/access.js'
import type { AuthorizedMemoryScope } from '../../src/agent/rag/memory-loader.js'

const actor: ImActor = { ownerId: 'owner-a', platform: 'telegram', botId: '7', chatType: 'group', chatId: 'group-a',
  platformUserId: 'member-a', role: 'member', allowedToolNames: ['search_memory'], speakerRoles: null, verifiedOwner: false, ownerMentionAuthorized: false }
const policy = { groupMemoryEnabled: true, memberMemoryEnabled: true }
const candidate = (groupId: string, type: 'group' | 'member' = 'member'): AuthorizedMemoryScope => ({ ownerId: actor.ownerId,
  platform: actor.platform, botId: actor.botId, type, id: type === 'group' ? groupId : `${groupId}:${actor.platformUserId}`, groupId })

test('四平台当前群默认只读当前公开群和本人成员scope，永不自动包含owner', () => {
  for (const platform of ['telegram', 'qq', 'feishu', 'wechat'] as const) {
    const scopes = resolveImMemorySearchScopes({ ...actor, platform }, 'auto', policy)
    assert.deepEqual(scopes.map(scope => [scope.type, scope.id]), [['group', 'group-a'], ['member', 'group-a:member-a']])
    assert.ok(scopes.every(scope => scope.platform === platform && scope.botId === actor.botId && scope.ownerId === actor.ownerId))
    assert.throws(() => resolveImMemorySearchScopes({ ...actor, platform }, 'private_memory', policy))
  }
})
test('只有显式all_my_groups可跨群，成员仅本人；去重并保留两群预算', () => {
  const stored = [candidate('group-a'), candidate('group-b'), candidate('group-b'), candidate('group-c'), candidate('group-d')]
  assert.equal(resolveImMemorySearchScopes(actor, 'auto', policy, stored).length, 2)
  assert.deepEqual(resolveImMemorySearchScopes(actor, 'all_my_groups', policy, stored).map(scope => scope.id),
    ['group-a', 'group-a:member-a', 'group-b:member-a', 'group-c:member-a'])
  for (const patch of [{ ownerId: 'owner-b' }, { botId: '8' }, { platform: 'qq' }, { id: 'group-b:member-b' }, { type: 'group' as const }])
    assert.throws(() => resolveImMemorySearchScopes(actor, 'all_my_groups', policy, [{ ...candidate('group-b'), ...patch }]))
})
test('群owner不读取owner私人记忆，私聊owner可读个人和最多三群', () => {
  const owner = { ...actor, role: 'owner' as const, allowedToolNames: null, verifiedOwner: true }
  assert.deepEqual(resolveImMemorySearchScopes(owner, 'auto', policy).map(scope => scope.type), ['group'])
  assert.throws(() => resolveImMemorySearchScopes(owner, 'private_memory', policy))
  const scopes = resolveImMemorySearchScopes({ ...owner, chatType: 'c2c', chatId: null }, 'auto', policy,
    ['g1', 'g2', 'g3', 'g4'].map(group => candidate(group, 'group')))
  assert.deepEqual(scopes.map(scope => scope.id), ['owner-a', 'g1', 'g2', 'g3'])
})
test('unknown和混合批次不借末条成员读取个人或跨群scope，Telegram不回落owner', () => {
  for (const value of [{ ...actor, role: 'unknown' as const }, { ...actor, speakerRoles: [
    { platformUserId: 'member-a', role: 'member' as const }, { platformUserId: 'member-b', role: 'member' as const }] }]) {
    assert.deepEqual(resolveImMemorySearchScopes(value, 'all_my_groups', policy, [candidate('group-b')]).map(scope => scope.type), ['group'])
    assert.throws(() => resolveImMemorySearchScopes({ ...value, chatType: 'c2c', chatId: null }, 'auto', policy))
  }
})
test('开关关闭不会偷偷回落owner，私聊成员仅用已归属本人的cursor', () => {
  assert.throws(() => resolveImMemorySearchScopes(actor, 'auto', { groupMemoryEnabled: false, memberMemoryEnabled: false }))
  assert.deepEqual(resolveImMemorySearchScopes(actor, 'auto', { ...policy, memberMemoryEnabled: false }).map(scope => scope.type), ['group'])
  const member = { ...actor, chatType: 'c2c' as const, chatId: null }
  assert.throws(() => resolveImMemorySearchScopes(member, 'auto', policy))
  assert.deepEqual(resolveImMemorySearchScopes(member, 'auto', policy, [candidate('group-b')]).map(scope => scope.id), ['group-b:member-a'])
  assert.throws(() => resolveImMemorySearchScopes(member, 'current_group', policy))
})
