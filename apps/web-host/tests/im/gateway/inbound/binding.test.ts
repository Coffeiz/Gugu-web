import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createUserBotBindingCodeIssuer } from '@gugu/core/im/binding-code'
import type { ImPreflightScope } from '@gugu/gateway'
import { createPostgresRedisBindingConsumer, IM_BINDING_CLEANUP_SCRIPT, IM_BINDING_VALIDATE_SCRIPT, ImBindingUnavailable } from '../../../../src/modules/im/gateway/inbound/binding.js'

const owner = '00000000-0000-4000-8000-000000000081'
const other = '00000000-0000-4000-8000-000000000082'
const secret = 'synthetic-binding-secret'
const scope: ImPreflightScope = { ownerId: owner, botId: '81', platform: 'qq', chatType: 'c2c', chatId: null, platformUserId: 'synthetic-sender', eventId: 'synthetic-event' }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** 仅为事务/失败语义及命令契约替身；真实SQL与Lua由显式隔离集成测试执行。 */
function fixture(platform: 'qq' | 'telegram' = 'qq') {
  const input = { ...scope, platform, platformUserId: platform === 'qq' ? 'synthetic-sender' : '8181' }
  let data = { bound: null as string | null, receipts: new Set<string>(), notifications: 0 }
  let enabled = true, active = true, failUpdate = false, failCleanup = false, failPublish = false, failedReport = false
  let commitHook = () => {}, validateHook = () => {}
  let tail = Promise.resolve(), invalidated = 0, published = 0
  const events: string[] = [], values = new Map<string, string>(), counters = new Map<string, number>()
  const redis = { async sendCommand(args: string[]): Promise<unknown> {
    if (args[0] === 'GET') return values.get(args[1]!) ?? null
    const [_, script, _count, key, attempts, raw, matched] = args
    if (script === IM_BINDING_CLEANUP_SCRIPT) {
      if (failCleanup) throw new Error('合成Redis敏感异常')
      if (values.get(key!) !== raw) return 0
      values.delete(key!); counters.delete(attempts!); return 1
    }
    assert.equal(script, IM_BINDING_VALIDATE_SCRIPT)
    validateHook()
    if (values.get(key!) !== raw || (counters.get(attempts!) ?? 0) >= 5) return 0
    if (matched === '1') return 1
    counters.set(attempts!, (counters.get(attempts!) ?? 0) + 1)
    return 0
  } }
  const pool = { async connect() {
    const previous = tail
    let unlock!: () => void
    tail = new Promise<void>(done => { unlock = done })
    await previous
    let transaction = { ...data, receipts: new Set(data.receipts) }
    return { release() { unlock() }, async query(text: string, params: unknown[] = []) {
      if (text === 'BEGIN') { transaction = { ...data, receipts: new Set(data.receipts) }; return { rows: [] } }
      if (text === 'ROLLBACK') return { rows: [] }
      if (text === 'COMMIT') { data = transaction; commitHook(); return { rows: [] } }
      if (text.includes('FOR UPDATE OF b,u')) return { rows: params[0] === input.botId && params[1] === owner && params[2] === platform && enabled && active
        ? [{ id: input.botId, owner_id: owner, platform, owner_platform_user_id: transaction.bound }] : [] }
      if (text.startsWith('SELECT 1 FROM gugu_im_binding_consumptions')) return { rows: transaction.receipts.has(String(params[2])) ? [{}] : [] }
      if (text.startsWith('INSERT INTO gugu_im_binding_consumptions')) {
        const key = String(params[3]); if (transaction.receipts.has(key)) throw new Error('合成唯一约束')
        transaction.receipts.add(key); return { rows: [] }
      }
      if (text.startsWith('UPDATE user_bots')) {
        if (failUpdate) throw new Error('合成SQL敏感异常')
        assert.equal(transaction.bound, null)
        transaction.bound = String(params[3]); return { rows: [{ id: input.botId }] }
      }
      if (text.includes('pg_notify')) { transaction.notifications++; return { rows: [] } }
      throw new Error('未识别查询契约')
    } } as unknown as PoolClient
  } } as Pick<Pool, 'connect'>
  const consumer = createPostgresRedisBindingConsumer({ pool, redis, secretKey: secret,
    invalidate() { invalidated++ }, async publishChanged() { if (failPublish) throw new Error('合成事件敏感异常'); published++ },
    report(event) { events.push(event); if (failedReport) throw new Error('合成诊断失败') } })
  const key = `im:${platform}-binding:${input.botId}`
  const issuer = createUserBotBindingCodeIssuer({
    query: async (_sql, params) => ({ rows: params[0] === Number(input.botId) && params[1] === owner && params[2] === platform ? [{ owner_platform_user_id: data.bound }] : [] }),
    save: async (name, value) => { values.set(name, value) }, generateCode: () => '123456', generateChallenge: () => 'synthetic-challenge',
    sign: value => createHmac('sha256', secret).update(value).digest('hex'),
  })
  return { input, consumer, key, values, counters, events, issue: () => issuer(owner, Number(input.botId), platform),
    get data() { return data }, get invalidated() { return invalidated }, get published() { return published },
    unbind() { data.bound = null }, setUpdateFailure(value: boolean) { failUpdate = value }, setCleanupFailure(value: boolean) { failCleanup = value },
    setPublishFailure(value: boolean) { failPublish = value }, setReportFailure() { failedReport = true },
    setEnabled(value: boolean) { enabled = value }, setActive(value: boolean) { active = value },
    beforeCleanup(fn: () => void) { commitHook = fn }, beforeValidate(fn: () => void) { validateHook = fn } }
}

test('现有issuer签发格式可被真实consumer验证，QQ重复同sender幂等，Telegram仅一次', async () => {
  for (const platform of ['qq', 'telegram'] as const) {
    const f = fixture(platform)
    const code = (await f.issue()).code
    const result = await f.consumer.consume(f.input, ` ${code.slice(0, 3)}\t${code.slice(3)} `)
    assert.deepEqual(result, { bound: true, changed: true, postCommit: 'complete' })
    assert.equal(f.data.bound, f.input.platformUserId)
    assert.equal(f.data.receipts.size, 1)
    assert.equal(f.values.has(f.key), false)
    assert.equal(f.data.notifications, 1)
    assert.equal(f.invalidated, 1); assert.equal(f.published, 1)
    assert.equal((await f.consumer.consume(f.input, code)).bound, platform === 'qq')
    assert.equal((await f.consumer.consume({ ...f.input, platformUserId: '99999' }, code)).bound, false)
    assert.equal(f.data.bound, f.input.platformUserId)
  }
})

test('错误码五次预算QQ按sender隔离，Telegram按整个challenge隔离', async () => {
  for (const platform of ['qq', 'telegram'] as const) {
    const f = fixture(platform), { code } = await f.issue()
    for (let i = 0; i < 5; i++) assert.equal((await f.consumer.consume(f.input, '999999')).bound, false)
    assert.equal((await f.consumer.consume(f.input, code)).bound, false)
    assert.equal((await f.consumer.consume({ ...f.input, platformUserId: '88888' }, code)).bound, platform === 'qq')
    if (platform === 'qq') assert.equal(f.counters.get(`im:qq-binding-attempts:81:synthetic-challenge:${hash(f.input.platformUserId).slice(0, 16)}`), 5)
  }
})

test('DB失败回滚绑定及消费收据且不耗尽正确码，恢复后仍可消费', async () => {
  const f = fixture(), { code } = await f.issue()
  f.setUpdateFailure(true)
  for (let i = 0; i < 6; i++) await assert.rejects(f.consumer.consume(f.input, code), { name: 'ImBindingUnavailable', message: 'IM 绑定暂时不可用' })
  assert.equal(f.data.bound, null); assert.equal(f.data.receipts.size, 0)
  assert.equal(f.values.has(f.key), true)
  assert.equal(f.counters.size, 0)
  f.setUpdateFailure(false)
  assert.equal((await f.consumer.consume(f.input, code)).bound, true)
})

test('Redis清理失败的已消费码不能在解绑后重放，aftercommit通知失败显式pending', async () => {
  const f = fixture('telegram'), { code } = await f.issue()
  f.setCleanupFailure(true); f.setPublishFailure(true); f.setReportFailure()
  assert.deepEqual(await f.consumer.consume(f.input, code), { bound: true, changed: true, postCommit: 'pending' })
  assert.equal(f.values.has(f.key), true)
  assert.equal(f.data.receipts.size, 1)
  assert.deepEqual(f.events, ['post-commit-pending'])
  f.unbind(); f.setCleanupFailure(false)
  assert.equal((await f.consumer.consume(f.input, code)).bound, false)
  assert.equal(f.data.bound, null)
})

test('挑战被重签发时验证CAS拒绝旧码，提交后清理不会删新码', async () => {
  const before = fixture(), { code } = await before.issue()
  before.beforeValidate(() => before.values.set(before.key, 'synthetic-new-challenge'))
  assert.equal((await before.consumer.consume(before.input, code)).bound, false)
  assert.equal(before.data.bound, null)
  const after = fixture(); await after.issue()
  after.beforeCleanup(() => after.values.set(after.key, 'synthetic-new-challenge'))
  assert.equal((await after.consumer.consume(after.input, code)).bound, true)
  assert.equal(after.values.get(after.key), 'synthetic-new-challenge')
})

test('跨owner、Bot、平台、群作用域、停用账户拒绝消费，未知格式不访问挑战', async () => {
  const f = fixture(), { code } = await f.issue()
  for (const mutation of [{ ownerId: other }, { botId: '82' }, { platform: 'telegram' as const, platformUserId: '8181' },
    { chatType: 'group' as const, chatId: 'synthetic-group' }])
    assert.equal((await f.consumer.consume({ ...f.input, ...mutation }, code)).bound, false)
  f.setEnabled(false); assert.equal((await f.consumer.consume(f.input, code)).bound, false)
  f.setEnabled(true); f.setActive(false); assert.equal((await f.consumer.consume(f.input, code)).bound, false)
  f.setActive(true)
  assert.equal((await f.consumer.consume(f.input, 'abc123')).bound, false)
  f.values.set(f.key, JSON.stringify({ user_id: other, code_hash: 'f'.repeat(64), challenge_id: 'synthetic-challenge' }))
  assert.equal((await f.consumer.consume(f.input, code)).bound, false)
  assert.equal(f.data.bound, null); assert.equal(f.data.receipts.size, 0)
  assert.equal(f.counters.size, 0)
})

test('QQ首次私聊并发只绑定一个身份，不需要绑定码，不影响Telegram或群', async () => {
  const f = fixture()
  const results = await Promise.all([f.consumer.bindFirstQqOwner(f.input), f.consumer.bindFirstQqOwner({ ...f.input, platformUserId: 'synthetic-second' })])
  assert.equal(results.filter(result => result.changed).length, 1)
  assert.equal(f.data.bound, 'synthetic-sender')
  assert.equal(f.data.notifications, 1)
  assert.equal(f.invalidated, 1)
  const telegram = fixture('telegram')
  assert.equal((await telegram.consumer.bindFirstQqOwner(telegram.input)).bound, false)
  const group = fixture()
  assert.equal((await group.consumer.bindFirstQqOwner({ ...group.input, chatType: 'group', chatId: 'synthetic-group' })).bound, false)
  assert.equal(group.data.bound, null)
})

test('取消发生在绑定提交前回滚，错误不包含挑战或输入值', async () => {
  const f = fixture(), { code } = await f.issue(), cancel = new AbortController()
  f.beforeValidate(() => cancel.abort(new Error('合成敏感取消正文')))
  await assert.rejects(f.consumer.consume(f.input, code, cancel.signal), error => error instanceof ImBindingUnavailable && !('cause' in error))
  assert.equal(f.data.bound, null); assert.equal(f.data.receipts.size, 0)
  assert.equal(f.values.has(f.key), true)
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_IM_GATEWAY_TEST_REDIS_URL
test('隔离PG与Redis：真实Lua预算、DB回滚保码、并发绑定及旧码持久防重放', {
  skip: !(pgUrl && redisUrl) && '未运行：须同时显式配置GUGU_IM_GATEWAY_TEST_DATABASE_URL和独占GUGU_IM_GATEWAY_TEST_REDIS_URL；替身不证明SQL/Lua原子性',
}, async () => {
  const { Pool } = await import('pg')
  const { createRedisGatewayIngressCommands } = await import('../../../../src/adapters/cache/redis-events.js')
  const commands = createRedisGatewayIngressCommands(redisUrl!)
  const schema = `im_binding_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  let pool: Pool | undefined
  const botId = String(randomInt(1_000_000_000, 2_000_000_000)), userId = randomUUID()
  const key = `im:telegram-binding:${botId}`, challenge = randomUUID().replaceAll('-', '')
  const attempts = `im:telegram-binding-attempts:${botId}:${challenge}`
  // 与生产消费者使用同一GET/EVAL受限客户端，夹具建键/清理也不放宽命令白名单。
  const save = (value: string, onlyIfAbsent = false) => commands.sendCommand(['EVAL',
    onlyIfAbsent ? "return redis.call('SET',KEYS[1],ARGV[1],'EX',600,'NX')" : "return redis.call('SET',KEYS[1],ARGV[1],'EX',600)", '1', key, value])
  const remove = (...keys: string[]) => commands.sendCommand(['EVAL', "return redis.call('DEL',unpack(KEYS))", String(keys.length), ...keys])
  let ownsRedisKey = false
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status varchar(16));
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid REFERENCES users(id),platform varchar(20),enabled boolean,
      owner_platform_user_id varchar(128),owner_bound_at timestamptz)`)
    await pool.query(imGatewaySql.bindingConsume)
    await pool.query("INSERT INTO users VALUES($1,true,'active')", [userId])
    await pool.query("INSERT INTO user_bots VALUES($1,$2,'telegram',true,NULL,NULL)", [botId, userId])
    const codeHash = createHmac('sha256', secret).update(`telegram:${botId}:${userId}:123456`).digest('hex')
    const payload = JSON.stringify({ user_id: userId, code_hash: codeHash, challenge_id: challenge })
    assert.equal(await save(payload, true), 'OK', '合成Redis键须不存在，不能覆盖既有数据')
    ownsRedisKey = true
    const input = { ...scope, ownerId: userId, botId, platform: 'telegram' as const, platformUserId: '8181' }
    const database = pool
    const consumer = createPostgresRedisBindingConsumer({ pool: database, redis: commands, secretKey: secret, invalidate() {}, async publishChanged() {}, report() {} })
    // 触发真实UPDATE约束失败，确认Redis码和PG收据均未丢失。
    await database.query("ALTER TABLE user_bots ADD CONSTRAINT synthetic_reject CHECK(owner_platform_user_id IS NULL)")
    await assert.rejects(consumer.consume(input, '123456'), ImBindingUnavailable)
    assert.equal(await commands.sendCommand(['GET', key]), payload)
    assert.equal((await database.query('SELECT count(*)::integer AS n FROM gugu_im_binding_consumptions')).rows[0].n, 0)
    await database.query('ALTER TABLE user_bots DROP CONSTRAINT synthetic_reject')
    const results = await Promise.all([consumer.consume(input, '123456'), consumer.consume({ ...input, platformUserId: '8282' }, '123456')])
    assert.equal(results.filter(result => result.changed).length, 1)
    // 仅恢复本次创建的同一合成挑战，模拟清理失败后数据库解绑；收据仍须拒绝旧码。
    await save(payload)
    await database.query('UPDATE user_bots SET owner_platform_user_id=NULL')
    assert.equal((await consumer.consume(input, '123456')).bound, false)
    await remove(attempts)
    // 新挑战上真实Lua五次错误预算仍拒绝正确码。
    const newer = JSON.stringify({ user_id: userId, code_hash: codeHash, challenge_id: `${challenge}new` })
    await save(newer)
    for (let i = 0; i < 5; i++) assert.equal((await consumer.consume(input, '999999')).bound, false)
    assert.equal((await consumer.consume(input, '123456')).bound, false)
    await remove(`im:telegram-binding-attempts:${botId}:${challenge}new`)
  } finally {
    if (ownsRedisKey) await remove(key, attempts)
    await pool?.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
