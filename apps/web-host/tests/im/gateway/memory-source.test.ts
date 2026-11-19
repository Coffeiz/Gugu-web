import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { ImActor } from '@gugu/core/im/access'
import { imMemoryMaintenanceScopeFileKey } from '../../../src/modules/admin/memory-apply.js'
import { createLocalImMemorySource, ImMemorySourceError, type ImMemoryReadAuthorization, type ImMemoryReadScope } from '../../../src/modules/im/gateway/memory/source.js'

const owner = '00000000-0000-4000-8000-000000000092'
const identity = { ownerId: owner, sessionId: '1', runId: 'synthetic-run' }
const actor: ImActor = { ownerId: owner, botId: '92', platform: 'qq', chatType: 'group', chatId: 'synthetic-group',
  platformUserId: 'synthetic-member', role: 'member', verifiedOwner: false, ownerMentionAuthorized: false,
  allowedToolNames: ['web_search'], speakerRoles: null }
const scope = (scope_type: 'group' | 'platform-user', scope_id: string, patch: Partial<ImMemoryReadScope> = {}): ImMemoryReadScope =>
  ({ owner_user_id: owner, platform: 'qq', bot_id: '92', scope_type, scope_id, ...patch })
const group = scope('group', 'synthetic-group'), member = scope('platform-user', 'synthetic-group:synthetic-member')
const safeError = (code: ImMemorySourceError['code']) => (error: unknown) => {
  assert.ok(error instanceof ImMemorySourceError)
  assert.equal(error.code, code)
  assert.equal(error.message, 'IM 记忆读取不可用')
  assert.equal(error.cause, undefined)
  return true
}

/** 本地文件读均走真实授权存储；只有当前权限与墓碑查询是可控替身。 */
async function fixture(work: (f: {
  root: string; write(scope: ImMemoryReadScope, file: string, value: string | Uint8Array): Promise<string>
  source(who?: ImActor, authorize?: (call: number) => ImMemoryReadAuthorization | null,
    tombstone?: (scope: ImMemoryReadScope, call: number) => boolean): ReturnType<typeof createLocalImMemorySource>
  authorization(who?: ImActor): ImMemoryReadAuthorization
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-im-memory-'))
  const authorization = (who = actor): ImMemoryReadAuthorization => ({ ownerId: who.ownerId, botId: who.botId, platform: who.platform,
    chatType: who.chatType, chatId: who.chatId, platformUserId: who.platformUserId, groupMemoryEnabled: true, memberMemoryEnabled: true })
  try {
    await work({ root, authorization,
      async write(value, file, content) {
        const path = join(root, imMemoryMaintenanceScopeFileKey(value, file))
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); return path
      },
      source(who = actor, authorize = () => authorization(who), tombstone = () => false) {
        let authorizations = 0, tombstones = 0
        return createLocalImMemorySource({ root, identity, actor: who,
          async authorize() { return authorize(++authorizations) }, async isTombstoned(value) { return tombstone(value, ++tombstones) } })
      },
    })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('真实文件只读取当前 owner/platform/Bot/群和成员的公开字段，不读长期记忆', async () => fixture(async f => {
  await f.write(group, 'summary.json', '{"text":"合成群摘要"}')
  await f.write(group, 'profile.json', '["合成群资料"]')
  await f.write(group, 'memory.md', '不应进入上下文的长期记忆')
  await f.write(group, 'members.json', '{broken-json')
  await f.write(member, 'summary.json', '{"text":"合成成员摘要"}')
  await f.write(member, 'profile.json', '{"text":"合成成员资料"}')
  await f.write(member, 'pattern.json', '[{"text":"合成偏好"}]')
  for (const other of [scope('group', 'another-group'), scope('group', 'synthetic-group', { bot_id: '93' }),
    scope('group', 'synthetic-group', { platform: 'telegram' }), scope('group', 'synthetic-group', { owner_user_id: 'other-owner' }),
    scope('platform-user', 'another-group:synthetic-member'), scope('platform-user', 'synthetic-group:another-member')])
    await f.write(other, 'summary.json', '{"text":"另一作用域的合成内容"}')
  assert.deepEqual(await f.source().loadImMemory(identity), {
    group: { summary: { text: '合成群摘要' }, profile: ['合成群资料'] },
    platform_user: { summary: { text: '合成成员摘要' }, profile: { text: '合成成员资料' }, pattern: [{ text: '合成偏好' }] },
  })
}))

test('私聊 member 只读取直接成员 scope，owner/unknown 不读取个人资料', async () => fixture(async f => {
  const privateActor = { ...actor, chatType: 'c2c' as const, chatId: null }
  await f.write(scope('platform-user', 'synthetic-member'), 'summary.json', '{"text":"合成私聊摘要"}')
  await f.write(member, 'summary.json', '{"text":"合成群内摘要"}')
  assert.deepEqual(await f.source(privateActor).loadImMemory(identity), {
    platform_user: { summary: { text: '合成私聊摘要' }, profile: {}, pattern: {} },
  })
  for (const role of ['owner', 'unknown'] as const)
    assert.deepEqual(await f.source({ ...privateActor, role }).loadImMemory(identity), {})
}))

test('当前 Bot 开关与墓碑决定真实缺省；删除过程中出现墓碑会移除已读资料', async () => fixture(async f => {
  assert.deepEqual(await f.source().loadImMemory(identity), { group: { summary: {}, profile: {} }, platform_user: { summary: {}, profile: {}, pattern: {} } })
  await f.write(group, 'summary.json', '{broken-json')
  await f.write(member, 'summary.json', '{broken-json')
  assert.deepEqual(await f.source(actor, () => ({ ...f.authorization(), groupMemoryEnabled: false, memberMemoryEnabled: false })).loadImMemory(identity), {})
  assert.deepEqual(await f.source(actor, undefined, () => true).loadImMemory(identity), {})
  await f.write(group, 'summary.json', '{"text":"合成待删除内容"}')
  const groupOnly = f.source(actor, () => ({ ...f.authorization(), memberMemoryEnabled: false }), (_scope, call) => call > 1)
  assert.deepEqual(await groupOnly.loadImMemory(identity), {})
}))

test('读取前与返回前复核身份、开关和授权，跨会话/运行调用拒绝', async () => fixture(async f => {
  await f.write(group, 'summary.json', '{"text":"合成授权资料"}')
  await assert.rejects(f.source(actor, call => call === 1 ? f.authorization() : null).loadImMemory(identity), safeError('unauthorized'))
  await assert.rejects(f.source(actor, call => ({ ...f.authorization(), groupMemoryEnabled: call === 1 })).loadImMemory(identity), safeError('unauthorized'))
  for (const patch of [{ ownerId: 'other' }, { botId: '93' }, { platformUserId: 'another-member' }, { chatId: 'another-group' }])
    await assert.rejects(f.source(actor, () => ({ ...f.authorization(), ...patch })).loadImMemory(identity), safeError('unauthorized'))
  for (const patch of [{ ownerId: 'other' }, { sessionId: '2' }, { runId: 'another-run' }])
    await assert.rejects(f.source().loadImMemory({ ...identity, ...patch }), safeError('invalid_scope'))
  const controller = new AbortController(); controller.abort('合成敏感取消原因')
  await assert.rejects(f.source().loadImMemory(identity, controller.signal), safeError('aborted'))
}))

test('坏 JSON、非对象/列表、坏 UTF8、超大文件和非普通文件失败而非伪空', async () => fixture(async f => {
  for (const content of ['{合成坏JSON', '', '"合成标量"', 'null', new Uint8Array([0xff]), ' '.repeat(2 * 1024 * 1024 + 1)]) {
    await f.write(group, 'summary.json', content)
    await assert.rejects(f.source().loadImMemory(identity), error => {
      assert.ok(error instanceof ImMemorySourceError)
      assert.ok(['invalid_data', 'unavailable'].includes(error.code))
      assert.doesNotMatch(error.stack ?? '', /合成坏JSON|合成标量|\.json/)
      assert.equal(error.cause, undefined); return true
    })
  }
  const path = join(f.root, imMemoryMaintenanceScopeFileKey(group, 'summary.json'))
  await rm(path); await mkdir(path)
  await assert.rejects(f.source().loadImMemory(identity), safeError('unavailable'))
}))

test('路径穿越无法构造已绑定的 IM 记忆来源', async () => fixture(async f => {
  for (const who of [{ ...actor, chatId: '../other' }, { ...actor, platformUserId: 'member/other' }])
    assert.throws(() => f.source(who), safeError('invalid_scope'))
}))

test('目录 symlink/junction 拒绝，不读取链接目标文件', async () => fixture(async f => {
  const outside = join(f.root, 'synthetic-outside'), target = join(f.root, dirname(imMemoryMaintenanceScopeFileKey(group, 'summary.json')))
  await mkdir(outside); await writeFile(join(outside, 'summary.json'), '{"text":"合成边界外资料"}')
  await mkdir(dirname(target), { recursive: true })
  await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.source().loadImMemory(identity), safeError('unavailable'))
}))
