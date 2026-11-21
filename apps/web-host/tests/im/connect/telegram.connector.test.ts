import { test } from 'node:test'
import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { createTelegramDeliveryApi } from '@gugu/gateway/telegram'
import { createTelegramConnector } from '../../../src/modules/im/connect/platforms/telegram/index.js'
import { markdownV2, splitMarkdownV2 } from '@gugu/core/im/telegram-format'

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789'
const otherToken = '654321:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789'
const ownerA = '00000000-0000-4000-8000-000000000001'
const ownerB = '00000000-0000-4000-8000-000000000002'

function setup() {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('${ownerA}'), ('${ownerB}');
    CREATE TABLE user_bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, platform TEXT NOT NULL,
      name TEXT NOT NULL, app_id TEXT, app_secret TEXT, sandbox INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, group_chat_enabled INTEGER NOT NULL DEFAULT 0,
      feishu_group_chat_enabled INTEGER, group_requires_at INTEGER NOT NULL DEFAULT 1,
      group_read_enabled INTEGER NOT NULL DEFAULT 0, group_attention_mode TEXT NOT NULL DEFAULT 'autonomous',
      group_attention_config_version INTEGER NOT NULL DEFAULT 0, group_memory_enabled INTEGER NOT NULL DEFAULT 1,
      member_memory_enabled INTEGER NOT NULL DEFAULT 1, group_owner_memory_enabled INTEGER NOT NULL DEFAULT 0,
      group_allowed_tools TEXT NOT NULL DEFAULT '[]', group_message_format TEXT NOT NULL DEFAULT 'compat',
      private_message_format TEXT NOT NULL DEFAULT 'markdown', private_streaming_enabled INTEGER NOT NULL DEFAULT 0,
      owner_platform_user_id TEXT, owner_bound_at TEXT, bot_platform_user_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, source TEXT NOT NULL,
      snapshot_expires_at TEXT, context_epoch INTEGER DEFAULT 0);
  `)
  const changed: string[] = []
  const connector = createTelegramConnector(db, {
    verify: async supplied => ({ id: supplied === token ? 9001 : 9002, username: supplied === token ? 'sample_bot' : 'new_bot', webhookUrl: '' }),
    encrypt: value => `encrypted:${value}`,
    platforms: () => ['telegram'],
    publishChanged: async ownerId => { changed.push(ownerId) },
    dialect: 'sqlite',
  })
  return { db, native, connector, changed }
}

test('new connection persists only the encrypted token and returns a secret-free bot DTO', async () => {
  const { db, native, connector, changed } = setup()
  try {
    const result = await connector.connect(ownerA, token)
    const stored = native.prepare('SELECT app_secret,platform,app_id,name,group_chat_enabled FROM user_bots WHERE id=?').get(result.id) as Record<string, unknown>
    assert.deepEqual(result, { id: result.id, platform: 'telegram', name: '@sample_bot', app_id: '9001', enabled: true })
    assert.deepEqual(stored, { app_secret: `encrypted:${token}`, platform: 'telegram', app_id: '9001', name: '@sample_bot', group_chat_enabled: 0 })
    assert.equal(JSON.stringify(result).includes(token), false)
    assert.deepEqual(changed, [ownerA])
  } finally { await db.destroy(); native.close() }
})

test('duplicate owner and cross-owner bot conflicts do not create a second connection', async () => {
  const { db, native, connector } = setup()
  try {
    await connector.connect(ownerA, token)
    await assert.rejects(connector.connect(ownerA, otherToken), (error: unknown) => (error as { statusCode?: number }).statusCode === 409)
    await assert.rejects(connector.connect(ownerB, token), (error: unknown) => (error as { statusCode?: number }).statusCode === 409)
    assert.equal(native.prepare("SELECT count(*) AS n FROM user_bots WHERE platform='telegram'").get()?.n, 1)
  } finally { await db.destroy(); native.close() }
})

test('failed verification leaves the previous credential and owner binding intact', async () => {
  const { db, native, connector } = setup()
  try {
    const original = await connector.connect(ownerA, token)
    native.prepare("UPDATE user_bots SET owner_platform_user_id='7001',owner_bound_at='2026-01-01T00:00:00Z' WHERE id=?").run(original.id)
    const broken = createTelegramConnector(db, {
      verify: async () => { throw new Error('upstream secret-bearing URL') }, encrypt: value => `encrypted:${value}`,
      platforms: () => ['telegram'], publishChanged: async () => undefined,
    })
    await assert.rejects(broken.replace(ownerA, original.id, otherToken), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 502)
      assert.equal(String(error).includes(token), false)
      return true
    })
    const stored = native.prepare('SELECT app_secret,owner_platform_user_id FROM user_bots WHERE id=?').get(original.id) as Record<string, unknown>
    assert.deepEqual(stored, { app_secret: `encrypted:${token}`, owner_platform_user_id: '7001' })
  } finally { await db.destroy(); native.close() }
})

test('successful replacement of a different Bot clears the old platform owner binding', async () => {
  const { db, native, connector } = setup()
  try {
    const original = await connector.connect(ownerA, token)
    native.prepare("UPDATE user_bots SET owner_platform_user_id='7001',owner_bound_at='2026-01-01T00:00:00Z' WHERE id=?").run(original.id)
    const result = await connector.replace(ownerA, original.id, otherToken)
    const stored = native.prepare('SELECT app_id,app_secret,owner_platform_user_id,owner_bound_at FROM user_bots WHERE id=?').get(original.id) as Record<string, unknown>
    assert.deepEqual(result, { ...original, name: '@new_bot', app_id: '9002' })
    assert.deepEqual(stored, { app_id: '9002', app_secret: `encrypted:${otherToken}`, owner_platform_user_id: null, owner_bound_at: null })
  } finally { await db.destroy(); native.close() }
})

test('malformed tokens and foreign replacement IDs are rejected before Telegram verification', async () => {
  const { db, native } = setup()
  let verifications = 0
  const connector = createTelegramConnector(db, {
    verify: async () => { verifications++; return { id: 9001 } },
    encrypt: value => `encrypted:${value}`, platforms: () => ['telegram'], publishChanged: async () => undefined,
    dialect: 'sqlite',
  })
  try {
    await assert.rejects(connector.connect(ownerA, 'not-a-token'), (error: unknown) => (error as { statusCode?: number }).statusCode === 400)
    const owned = await connector.connect(ownerA, token)
    verifications = 0
    await assert.rejects(connector.replace(ownerB, owned.id, otherToken), (error: unknown) => (error as { statusCode?: number }).statusCode === 404)
    assert.equal(verifications, 0)
  } finally { await db.destroy(); native.close() }
})

test('Telegram verification uses only the fixed HTTPS origin and never follows a redirect', async () => {
  const requests: string[] = []
  const transport = {
    request: async (input: { url: string }) => {
      requests.push(input.url)
      const result = input.url.endsWith('/getMe')
        ? { ok: true, result: { id: 9001, username: 'sample_bot' } }
        : { ok: true, result: { url: '' } }
      return { status: 200, headers: new Headers(), body: (async function* () { yield new TextEncoder().encode(JSON.stringify(result)) })(), cancel: async () => undefined }
    },
    close: async () => undefined,
  }
  const verified = await createTelegramDeliveryApi(transport as never).verify(token)
  assert.deepEqual(verified, { id: 9001, username: 'sample_bot', webhookUrl: '' })
  assert.deepEqual(requests, [
    `https://api.telegram.org/bot${token}/getMe`,
    `https://api.telegram.org/bot${token}/getWebhookInfo`,
  ])

  let followed = false
  const redirecting = {
    ...transport,
    request: async (input: { url: string }) => {
      requests.push(input.url)
      if (followed) throw new Error('unexpected second request')
      followed = true
      return { status: 302, headers: new Headers({ location: 'https://attacker.invalid/collect' }), body: (async function* () { yield new TextEncoder().encode('') })(), cancel: async () => undefined }
    },
  }
  await assert.rejects(createTelegramDeliveryApi(redirecting as never).verify(token), (error: unknown) => {
    assert.equal((error as Error).message.includes(token), false)
    return true
  })
  assert.equal(followed, true)
})

test('Telegram photo delivery falls back to a bounded document upload only after a confirmed 400', async () => {
  const requests: Array<{ url: string; headers: Readonly<Record<string, string>>; body?: unknown }> = []
  const api = createTelegramDeliveryApi({ async request(request) {
    requests.push(request)
    const body = requests.length === 1 ? '{"ok":false,"error_code":400}' : '{"ok":true,"result":{"message_id":21}}'
    return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode(body) })(), async cancel() {} }
  } } as never)
  assert.equal(await api.sendAttachment(token, '7001', { bytes: new Uint8Array([1, 2, 3]),
    filename: 'report.png', mime: 'image/png' }), true)
  assert.deepEqual(requests.map(request => request.url), [
    `https://api.telegram.org/bot${token}/sendPhoto`,
    `https://api.telegram.org/bot${token}/sendDocument`,
  ])
  for (const [index, field] of ['photo', 'document'].entries()) {
    assert.match(requests[index]?.headers['content-type'] ?? '', /^multipart\/form-data; boundary=guguTelegram/u)
    let raw = ''
    for await (const part of requests[index]?.body as AsyncIterable<Uint8Array>) raw += new TextDecoder().decode(part)
    assert.match(raw, /name="chat_id"\r\n\r\n7001/u)
    assert.match(raw, new RegExp(`name="${field}"; filename="report\\.png"\\r\\nContent-Type: image/png`))
    assert.ok(raw.endsWith('\u0001\u0002\u0003\r\n--' + requests[index]?.headers['content-type'].split('boundary=')[1] + '--\r\n'))
  }
  assert.equal(await api.sendAttachment(token, '7001', { bytes: new Uint8Array(50_000_001),
    filename: 'large.pdf', mime: 'application/pdf' }), false)
  assert.equal(requests.length, 2)
})

test('Telegram 401 response maps to the Python invalid-token status without exposing upstream text', async () => {
  const { db, native } = setup()
  const transport = {
    request: async () => ({ status: 401, headers: new Headers(), body: (async function* () {
      yield new TextEncoder().encode(JSON.stringify({ ok: false, error_code: 401, description: `unauthorized ${token}` }))
    })(), cancel: async () => undefined }),
    close: async () => undefined,
  }
  const connector = createTelegramConnector(db, {
    verify: value => createTelegramDeliveryApi(transport as never).verify(value),
    encrypt: value => `encrypted:${value}`, platforms: () => ['telegram'], publishChanged: async () => undefined,
    dialect: 'sqlite',
  })
  try {
    await assert.rejects(connector.connect(ownerA, token), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400)
      assert.equal(String(error).includes(token), false)
      assert.equal(String(error).includes('unauthorized'), false)
      return true
    })
    assert.equal(native.prepare('SELECT count(*) AS n FROM user_bots').get()?.n, 0)
  } finally { await db.destroy(); native.close() }
})

test('Telegram sendMessage uses the fixed official HTTPS origin and passes text as JSON', async () => {
  const requests: Array<{ url: string; body: unknown }> = []
  const api = createTelegramDeliveryApi({ async request(request) {
    requests.push({ url: request.url, body: request.body })
    return { status: 200, headers: {}, body: (async function* () {
      yield Buffer.from('{"ok":true,"result":{"message_id":17}}')
    })(), async cancel() {} }
  } })
  assert.equal(await api.sendMessage(token, '-1007002', '安全合成消息'), true)
  assert.deepEqual(requests, [{
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    body: { chat_id: '-1007002', text: '安全合成消息', parse_mode: 'MarkdownV2' },
  }])
  assert.equal(await api.sendMessage(token, '', '不发送'), false)
  assert.equal(requests.length, 1)
})

test('Telegram MarkdownV2 keeps supported formatting and renders unsafe links as escaped text', () => {
  const formatted = markdownV2('**bold _inner_** and *italic!* [link](https://example.test/a?x=1&y=2)\n`a_b`\n[unsafe](javascript:alert(1))')
  assert.equal(formatted, '*bold \\_inner\\_* and _italic\\!_ [link](https://example.test/a?x=1&y=2)\n`a_b`\nunsafe (javascript:alert\\(1)\\)')
})

test('Telegram MarkdownV2 renders lists and splits long fenced code into closed blocks', () => {
  assert.equal(markdownV2('- 普通项\n1) 有序项\n- [x] 完成\n- [ ] 未完成'), '• 普通项\n1\\. 有序项\n☑ 完成\n☐ 未完成')
  const content = 'a_b😀'.repeat(400) + '\n'
  const chunks = splitMarkdownV2('```python\n' + content + '```', 512)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(chunk => chunk.startsWith('```python\n') && chunk.endsWith('```')))
  assert.ok(chunks.every(chunk => chunk.length <= 512))
  assert.equal(chunks.map(chunk => chunk.slice('```python\n'.length, -3)).join(''), content)
})

test('Telegram MarkdownV2 splits long emoji by UTF-16 units and retains all source text', async () => {
  const source = '😀'.repeat(2100)
  const chunks = splitMarkdownV2(source)
  assert.equal(chunks.length, 2)
  assert.equal(chunks.map(chunk => [...chunk].length).join(','), '2032,68')
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk, 'utf16le') / 2 <= 4096))

  const requests: Array<{ body: unknown }> = []
  const api = createTelegramDeliveryApi({ async request(request) {
    requests.push({ body: request.body })
    return { status: 200, headers: {}, body: (async function* () {
      yield Buffer.from('{"ok":true,"result":{"message_id":17}}')
    })(), async cancel() {} }
  } })
  assert.equal(await api.sendMessage(token, '-1007002', source), true)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map(item => (item.body as { parse_mode: string }).parse_mode), ['MarkdownV2', 'MarkdownV2'])
  assert.equal(requests.map(item => (item.body as { text: string }).text).join(''), source)
})

test('Telegram MarkdownV2 falls back to escaped chunks without cutting code points', () => {
  const chunks = splitMarkdownV2('😀a_b '.repeat(1000) + '尾', 512)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(chunk => chunk.length <= 512))
  assert.ok(chunks.join('').includes('a\\_b'))
  assert.ok(chunks.join('').endsWith('尾'))
})
