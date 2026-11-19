import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import type { ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { createPostgresImGatewayAdmission, ImGatewayAdmissionError } from '../../../src/modules/im/gateway/admission-postgres.js'

const owner = '00000000-0000-4000-8000-000000000093', other = '00000000-0000-4000-8000-000000000094'
const scope: ImPreflightScope = { ownerId: owner, platform: 'wechat', botId: '93', chatType: 'c2c', chatId: null,
  platformUserId: 'synthetic-sender', eventId: 'synthetic-sensitive-context-token' }
const binding = { ownerId: owner, platform: 'wechat' as const, botId: '93' }
const input = () => ({ scope, text: '合成普通正文', hasPendingMedia: false, quotedText: null, mediaIds: [] as string[] })
const receivedAt = '2026-01-01 00:00:00.123456+00'
const error = (code: ImGatewayAdmissionError['code']) => (value: unknown) => {
  assert.ok(value instanceof ImGatewayAdmissionError); assert.equal(value.code, code)
  assert.equal(value.message, 'IM 入站准入尚未完成'); assert.equal(value.cause, undefined); return true
}
type Row = { key: string; fingerprint: string; state: string; token: string | null; received_at: string }

/** 事务/查询替身只覆盖Host投影与状态契约；PG锁、时间精度和并发另由opt-in真实数据库验证。 */
function fixture() {
  let rows: Row[] = [], allowed = true, failing = false, platforms = ['wechat', 'qq', 'feishu', 'telegram']
  const parameters: unknown[][] = []
  const pool = { async connect() {
    let current = rows
    return { async query(sql: string, values: unknown[] = []) {
      parameters.push(values)
      const result = (data: unknown[]) => ({ rows: data, rowCount: data.length })
      if (sql === 'BEGIN') { current = structuredClone(rows); return result([]) }
      if (sql === 'COMMIT') { rows = current; return result([]) }
      if (sql === 'ROLLBACK') return result([])
      if (failing) throw new Error('synthetic-sensitive-context-token 合成敏感数据库正文')
      if (sql.startsWith('SELECT 1 FROM user_bots')) return result(allowed ? [{}] : [])
      if (sql.startsWith('INSERT INTO gugu_im_gateway_admissions')) {
        const key = JSON.stringify(values.slice(0, 6)); if (current.some(row => row.key === key)) return result([])
        const row = { key, fingerprint: String(values[6]), state: 'pending', token: String(values[7]), received_at: receivedAt }
        current.push(row); return result([row])
      }
      if (sql.startsWith('SELECT fingerprint,state,')) return result(current.filter(row => row.key === JSON.stringify(values)))
      if (sql.startsWith('UPDATE gugu_im_gateway_admissions')) {
        const row = current.find(row => row.key === JSON.stringify(values.slice(0, 6)) && row.token === values[6] && row.state === 'pending')
        if (!row) return result([])
        row.state = String(values[7]); row.token = null; return result([row])
      }
      if (sql.startsWith('SELECT state,count')) {
        const matching = current.filter(row => JSON.stringify(JSON.parse(row.key).slice(0, 3)) === JSON.stringify(values))
        return result(['pending', 'unknown'].map(state => ({ state, count: String(matching.filter(row => row.state === state).length) })))
      }
      throw new Error('测试未声明的准入SQL')
    }, release() {} } as unknown as PoolClient
  } } as Pick<Pool, 'connect'>
  const make = () => createPostgresImGatewayAdmission({ pool, secretKey: 'synthetic-admission-key', supportedPlatforms: () => platforms })
  return { make, rows: () => rows, parameters, allow(value: boolean) { allowed = value }, fail() { failing = true }, disable() { platforms = [] } }
}

test('首次准入持久pending及精确DB时间，控制event独立HMAC且不泄露原生context token', async () => {
  const f = fixture(), store = f.make(), first = await store.begin(input())
  assert.equal(first.status, 'first'); assert.equal(first.receivedAt, receivedAt); assert.match(first.controlEventId, /^[a-f0-9]{64}$/u)
  assert.notEqual(first.controlEventId, JSON.parse(f.rows()[0]!.key)[5])
  assert.deepEqual(await store.health(binding), { pending: 1, unknown: 0 })
  await assert.rejects(store.begin(input()), error('pending'))
  assert.equal(JSON.stringify(f.rows()).includes(scope.eventId), false)
  assert.equal(JSON.stringify(f.rows()).includes(input().text), false)
  assert.equal(JSON.stringify(f.parameters).includes(scope.eventId), false)
})

test('已admitted事件经重启仍固定为普通消息，临时凭据不进入语义指纹', async () => {
  const f = fixture(), store = f.make(), first = await store.begin(input()); assert.equal(first.status, 'first')
  if (first.status !== 'first') return
  await store.finish(scope, first.token, 'enqueue')
  const rotated = { ...input(), context_token: 'rotated-sensitive-token', temporary_url: 'https://media.example.test/file?token=rotated' }
  const replay = await f.make().begin(rotated)
  assert.deepEqual(replay, { status: 'admitted', receivedAt, controlEventId: first.controlEventId })
  assert.deepEqual(await store.health(binding), { pending: 0, unknown: 0 })
  for (const changed of [{ ...input(), text: '同一事件改正文' }, { ...input(), mediaIds: ['different-native-file'] }, { ...input(), hasPendingMedia: true }])
    await assert.rejects(store.begin(changed), error('conflict'))
})

test('已消费控制重放保持consumed，pending/unknown不因时间或重启重新执行', async () => {
  const f = fixture(), store = f.make(), first = await store.begin(input()); assert.equal(first.status, 'first')
  if (first.status !== 'first') return
  await store.finish(scope, first.token, 'consumed')
  assert.equal((await f.make().begin(input())).status, 'consumed')
  const next = { ...input(), scope: { ...scope, eventId: 'synthetic-other-event' } }, pending = await store.begin(next)
  assert.equal(pending.status, 'first'); if (pending.status !== 'first') return
  await store.markUnknown(next.scope, pending.token)
  await assert.rejects(f.make().begin(next), error('unknown'))
  assert.deepEqual(await store.health(binding), { pending: 0, unknown: 1 })
  await assert.rejects(store.finish(next.scope, pending.token, 'enqueue'), error('conflict'))
})

test('owner/Bot/平台/群/私聊/发言人各自隔离，当前停用或平台关闭不能读取旧准入', async () => {
  const f = fixture(), store = f.make()
  for (const patch of [{}, { ownerId: other }, { botId: '94' }, { platform: 'qq' as const },
    { chatType: 'group' as const, chatId: 'synthetic-group' }, { chatType: 'group' as const, chatId: 'another-group' }, { platformUserId: 'another-sender' }])
    assert.equal((await store.begin({ ...input(), scope: { ...scope, ...patch } })).status, 'first')
  assert.equal(f.rows().length, 7)
  f.allow(false); await assert.rejects(store.begin(input()), error('unauthorized'))
  f.allow(true); f.disable(); await assert.rejects(store.begin(input()), error('unauthorized'))
})

test('结束准入须持有同scope token；无效身份和DB失败均固定错误且不带原异常', async () => {
  const f = fixture(), store = f.make(), first = await store.begin(input()); assert.equal(first.status, 'first')
  if (first.status !== 'first') return
  await assert.rejects(store.finish(scope, 'wrong-token', 'enqueue'), error('conflict'))
  await assert.rejects(store.finish({ ...scope, platformUserId: 'another-sender' }, first.token, 'enqueue'), error('conflict'))
  await assert.rejects(store.begin({ ...input(), scope: { ...scope, ownerId: 'invalid-owner' } }), error('invalid_input'))
  f.fail(); await assert.rejects(store.begin(input()), error('unavailable')); assert.equal(f.rows()[0]!.state, 'pending')
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PG准入：真实唯一冲突、微秒cutoff、状态恢复和Bot停用', { skip: !pgUrl && '需显式隔离PG连接；查询替身不能证明真实锁与唯一约束' }, async () => {
  const { Pool } = await import('pg'), schema = `im_admission_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl }); let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean NOT NULL,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),platform text NOT NULL,enabled boolean NOT NULL,group_chat_enabled boolean,feishu_group_chat_enabled boolean)`)
    await pool.query("INSERT INTO users VALUES($1,true,'active')", [owner]); await pool.query("INSERT INTO user_bots VALUES(93,$1,'wechat',true,true,NULL)", [owner])
    await pool.query(await readFile(new URL('../../../src/modules/im/gateway/admission-schema.sql', import.meta.url), 'utf8'))
    const store = createPostgresImGatewayAdmission({ pool, secretKey: 'synthetic-admission-key', supportedPlatforms: () => ['wechat'] })
    const attempts = await Promise.allSettled([store.begin(input()), store.begin(input())])
    const first = attempts.find(attempt => attempt.status === 'fulfilled')
    assert.ok(first?.status === 'fulfilled' && first.value.status === 'first')
    const duplicate = attempts.find(attempt => attempt.status === 'rejected'); assert.ok(duplicate?.status === 'rejected'); assert.ok(duplicate.reason instanceof ImGatewayAdmissionError); assert.equal(duplicate.reason.code, 'pending')
    const actual = (await pool.query('SELECT first_received_at::text AS value FROM gugu_im_gateway_admissions')).rows[0].value
    assert.equal(first.value.receivedAt, actual)
    await store.finish(scope, first.value.token, 'enqueue')
    assert.equal((await store.begin(input())).status, 'admitted')
    const next = { ...input(), scope: { ...scope, eventId: 'synthetic-next-event' } }, pending = await store.begin(next)
    assert.equal(pending.status, 'first'); if (pending.status !== 'first') return
    await store.markUnknown(next.scope, pending.token); assert.deepEqual(await store.health(binding), { pending: 0, unknown: 1 })
    await pool.query('UPDATE user_bots SET enabled=false'); await assert.rejects(store.begin(input()), error('unauthorized'))
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
