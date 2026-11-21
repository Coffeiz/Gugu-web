import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool } from 'pg'
import type { ImActorInput } from '@gugu/core/im/access'
import { createPostgresImAccess } from '../../../../src/modules/im/gateway/inbound/access.js'

const owner = '00000000-0000-4000-8000-000000000071'
const other = '00000000-0000-4000-8000-000000000072'
const input: ImActorInput = { ownerId: owner, botId: '71', platform: 'qq', chatType: 'group', platformUserId: 'synthetic-owner',
  chatId: 'synthetic-group', botMentioned: true, mentionsOtherBot: false }
const row = () => ({ id: '71', owner_id: owner, platform: 'qq', enabled: true, is_active: true, account_status: 'active' as string | null,
  owner_platform_user_id: 'synthetic-owner' as string | null, group_allowed_tools: ['web_search', 'group_context_search'] as unknown,
  group_owner_memory_enabled: true, group_chat_enabled: true, feishu_group_chat_enabled: null })
/** 查询替身只验证Host投影、实时复核与Core规则；真正SQL隔离另由显式PG测试验证。 */
function fixture() {
  let current: Record<string, unknown> | null = row(), failure = false, supported = ['qq', 'feishu', 'wechat', 'telegram']
  const calls: unknown[][] = []
  const access = createPostgresImAccess({ supportedPlatforms: () => supported,
    async query(_statement, parameters) {
      calls.push(parameters)
      if (failure) throw new Error('合成敏感数据库正文')
      return { rows: current ? [current] : [] }
    } })
  return { access, calls, set(value: Record<string, unknown> | null) { current = value },
    fail() { failure = true }, disablePlatform() { supported = [] } }
}

test('可信Bot快照复用同批speaker，混合批次降为最弱权限且不查询平台凭据', async () => {
  const f = fixture(), snapshot = await f.access.snapshot(input)
  const actor = snapshot.actor({ ...input, speakers: [{ platformUserId: 'synthetic-owner' }, { platformUserId: 'synthetic-member' }] })
  assert.equal(actor.role, 'member')
  assert.equal(actor.verifiedOwner, false)
  assert.deepEqual(actor.allowedToolNames, ['web_search', 'http_get', 'group_context_search'])
  assert.equal(f.calls.length, 1)
  assert.equal(Object.isFrozen(snapshot.bot.groupAllowedTools), true)
  assert.equal('app_secret' in snapshot.bot, false)
  const policy = snapshot.actorPolicy({ ...input, platformUserId: 'synthetic-member' }, true)
  assert.equal(policy.loadOwnerContext, false)
  assert.equal(policy.groupOwnerMemoryEnabled, false)
})

test('快照拒绝跨owner、Bot、平台和私聊群域复用，伪造行归属不能成为可信Bot', async () => {
  const f = fixture(), snapshot = await f.access.snapshot(input)
  for (const mutation of [{ ownerId: other }, { botId: '72' }, { platform: 'telegram' as const }, { chatType: 'c2c' as const }])
    assert.throws(() => snapshot.resolve({ ...input, ...mutation }), /IM 权限不可用/)
  for (const mutation of [{ owner_id: other }, { id: '72' }, { platform: 'feishu' }]) {
    f.set({ ...row(), ...mutation })
    assert.equal(await f.access.readBot(input), null)
  }
})

test('四平台角色仅依据可信Bot绑定，Telegram未知私聊不提升owner', async () => {
  const f = fixture()
  for (const platform of ['qq', 'feishu', 'wechat', 'telegram'] as const) {
    f.set({ ...row(), platform })
    assert.equal((await f.access.resolveActor({ ...input, platform, ...(platform === 'wechat' ? { chatType: 'c2c' as const, chatId: null } : {}) })).role, 'owner')
    if (platform === 'wechat') await assert.rejects(f.access.resolveActor({ ...input, platform }), /IM 权限不可用/)
    const stranger = await f.access.resolveActor({ ...input, platform, platformUserId: 'synthetic-stranger', chatType: 'c2c', chatId: null })
    assert.equal(stranger.role, platform === 'feishu' || platform === 'wechat' ? 'owner' : platform === 'telegram' ? 'unknown' : 'member')
  }
})

test('解绑与白名单撤销实时拒绝工具及旧Run投递，原快照不冒充实时授权', async () => {
  const f = fixture(), snapshot = await f.access.snapshot(input), ownerActor = snapshot.actor(input)
  assert.equal(await f.access.authorizeTool(input, 'create_skill'), true)
  f.set({ ...row(), owner_platform_user_id: null })
  assert.equal(await f.access.authorizeTool(input, 'create_skill'), false)
  assert.equal(await f.access.authorizeDelivery(ownerActor, snapshot.bot), false)
  assert.equal(snapshot.actor(input).role, 'owner')
  f.set(row())
  const memberInput = { ...input, platformUserId: 'synthetic-member' }
  const member = await f.access.resolveActor(memberInput)
  assert.equal(await f.access.authorizeTool(memberInput, 'group_context_search'), true)
  f.set({ ...row(), group_allowed_tools: ['web_search'] })
  assert.equal(await f.access.authorizeTool(memberInput, 'group_context_search'), false)
  assert.equal(await f.access.authorizeDelivery(member), false)
  assert.ok(f.calls.length >= 7)
})

test('停用、删除、账户挂起及平台停用立即拒绝，不降级unknown继续执行默认工具', async () => {
  const f = fixture(), actor = await f.access.resolveActor(input)
  for (const value of [null, { ...row(), enabled: false }, { ...row(), is_active: false }, { ...row(), account_status: 'suspended' }]) {
    f.set(value)
    assert.equal(await f.access.authorizeTool(input, 'get_current_time'), false)
    assert.equal(await f.access.authorizeDelivery(actor), false)
    await assert.rejects(f.access.resolveActor(input), /IM 权限不可用/)
  }
  f.set(row()); f.disablePlatform()
  assert.equal(await f.access.readBot(input), null)
})

test('群开关撤销即时阻断已有Run的工具和投递，飞书null保持旧默认且私聊独立', async () => {
  for (const platform of ['qq', 'telegram', 'feishu'] as const) {
    const f = fixture(), candidate = { ...input, platform };
    f.set({ ...row(), platform });
    const actor = await f.access.resolveActor(candidate);
    assert.equal(await f.access.authorizeDelivery(actor), true);
    f.set({ ...row(), platform, ...(platform === 'feishu' ? { feishu_group_chat_enabled: false } : { group_chat_enabled: false }) });
    assert.equal(await f.access.authorizeTool(candidate, 'get_current_time'), false);
    assert.equal(await f.access.authorizeDelivery(actor), false);
    assert.equal((await f.access.resolveActor({ ...candidate, chatType: 'c2c', chatId: null })).role, 'owner');
  }
})

test('群owner记忆撤销阻止旧记忆回复，空账户状态兼容现有Node认证，坏记录与SQL错误静态脱敏', async () => {
  const f = fixture(), snapshot = await f.access.snapshot(input), actor = snapshot.actor(input)
  f.set({ ...row(), group_owner_memory_enabled: false })
  assert.equal(await f.access.authorizeDelivery(actor, snapshot.bot), false)
  f.set({ ...row(), account_status: null })
  assert.equal(await f.access.authorizeDelivery(actor), true)
  f.set({ ...row(), group_allowed_tools: { forged: true } })
  await assert.rejects(f.access.readBot(input), { message: 'IM 权限不可用' })
  f.fail()
  await assert.rejects(f.access.readBot(input), error => error instanceof Error && error.message === 'IM 权限不可用' && !('cause' in error))
  const before = f.calls.length
  await assert.rejects(f.access.readBot({ ...input, ownerId: 'invalid' }), /IM 权限不可用/)
  assert.equal(f.calls.length, before)
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PostgreSQL：真实JOIN按owner/Bot/平台隔离并立即观察账户和工具撤销', {
  skip: !pgUrl && '未运行：须显式设置 GUGU_IM_GATEWAY_TEST_DATABASE_URL；查询替身不证明PostgreSQL隔离',
}, async () => {
  const { Pool } = await import('pg')
  const schema = `im_access_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status varchar(16));
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid REFERENCES users(id),platform varchar(20),enabled boolean,
      owner_platform_user_id varchar(128),group_allowed_tools json,group_owner_memory_enabled boolean,
      group_chat_enabled boolean DEFAULT true,feishu_group_chat_enabled boolean)`)
    await pool.query('INSERT INTO users VALUES($1,true,\'active\'),($2,true,\'active\')', [owner, other])
    await pool.query(`INSERT INTO user_bots(id,user_id,platform,enabled,owner_platform_user_id,group_allowed_tools,group_owner_memory_enabled) VALUES(71,$1,'qq',true,'synthetic-owner','["group_context_search"]',true),
      (72,$2,'qq',true,'synthetic-owner','[]',false)`, [owner, other])
    const db = pool
    const access = createPostgresImAccess({ query: (text, params) => db.query(text, params), supportedPlatforms: () => ['qq'] })
    assert.equal(await access.readBot({ ...input, ownerId: other }), null)
    assert.equal(await access.readBot({ ...input, botId: '72' }), null)
    const member = { ...input, platformUserId: 'synthetic-member' }
    assert.equal(await access.authorizeTool(member, 'group_context_search'), true)
    const originalActor = await access.resolveActor(input)
    await db.query('UPDATE user_bots SET group_chat_enabled=false WHERE id=71')
    assert.equal(await access.authorizeTool(member, 'get_current_time'), false)
    assert.equal(await access.authorizeDelivery(originalActor), false)
    assert.equal((await access.resolveActor({ ...input, chatType: 'c2c', chatId: null })).role, 'owner')
    await db.query('UPDATE user_bots SET group_chat_enabled=true WHERE id=71')
    await db.query("UPDATE user_bots SET group_allowed_tools='[]' WHERE id=71")
    assert.equal(await access.authorizeTool(member, 'group_context_search'), false)
    await db.query("UPDATE users SET account_status='suspended' WHERE id=$1", [owner])
    assert.equal(await access.readBot(input), null)
  } finally {
    await pool?.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
