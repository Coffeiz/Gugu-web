import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPostgresGreetingContextReader, createRedisGreetingCache, createStandaloneGreetingCompleter } from '../../src/modules/agent-sessions/greeting.js'
import { encryptByokEnvelope, type ByokCredential } from '../../src/modules/agent/model-config/byok.js'

const owner = '11111111-1111-4111-8111-111111111111'

test('问候上下文只读取当前 owner 的项目、消息和安全记忆文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-greeting-'))
  try {
    const directory = join(root, owner, '.agent')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'summary.json'), JSON.stringify({ text: '最近在学做面包', ts: 1_795_200_000 }))
    await writeFile(join(directory, 'profile.json'), JSON.stringify([{ text: '喜欢慢慢散步' }]))
    await writeFile(join(directory, 'daily.md'), '## 2026-11-15\n- 海边散步')
    await writeFile(join(directory, 'stance.json'), JSON.stringify({ stance: '闲聊', ts: 1_795_200_000 }))
    const queries: Array<{ sql: string; values: unknown[] }> = []
    const pool = { async query(sql: string, values: unknown[]) {
      queries.push({ sql, values })
      if (sql.includes('SELECT timezone')) return { rows: [{ timezone: 'Asia/Tokyo' }] }
      if (sql.includes('conversation_messages')) return { rows: [{ created_at: new Date('2026-11-16T07:00:00Z') }] }
      if (sql.includes('FROM projects')) return { rows: [{ id: 7, name: '周末烘焙', status: 'active', progress: 30, priority: 'high', start_date: null, deadline: '2026-11-20' }] }
      throw new Error('unexpected query')
    } }
    const read = createPostgresGreetingContextReader(pool as never, root, 'UTC')
    const context = await read(owner, new AbortController().signal)
    assert.equal(context.timeZone, 'Asia/Tokyo')
    assert.equal(context.lastMessageAt?.toISOString(), '2026-11-16T07:00:00.000Z')
    assert.deepEqual(context.projects, [{ id: 7, name: '周末烘焙', status: 'active', progress: 30, priority: 'high', startDate: null, deadline: '2026-11-20' }])
    assert.equal(context.memory?.summary, '最近在学做面包')
    assert.deepEqual(context.memory?.daily, [{ date: '2026-11-15', note: '海边散步' }])
    assert.deepEqual(context.stance, { value: '闲聊', updatedAt: new Date(1_795_200_000_000) })
    assert.equal(queries.length, 3)
    assert.ok(queries.every(query => query.values[0] === owner))
    assert.ok(queries[1]!.sql.includes('s.user_id = $1'))
    assert.ok(queries[2]!.sql.includes('user_id = $1'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Redis greeting lock 使用互斥写和 token 校验释放', async () => {
  const commands: Array<{ command: string; args: unknown[] }> = []
  let unlocked = false
  const cache = createRedisGreetingCache({
    async set(...args: unknown[]) { commands.push({ command: 'SET', args }); return 'OK' },
    async eval(...args: unknown[]) { commands.push({ command: 'EVAL', args }); unlocked = true; return 1 },
    async exists() { return 0 },
  } as never, async () => null)
  const lock = await cache.acquire('agent:greeting:v2:owner-a:zh-CN:lock', 60, 15)
  assert.ok(lock)
  assert.equal((commands[0]!.args as unknown[]).slice(-3).join(' '), 'EX 60 NX')
  await lock!.release()
  assert.equal(unlocked, true)
  assert.equal(commands[1]!.command, 'EVAL')
})

test('问候 standalone Provider 使用池选模型并将 BYOK 凭据绑定到对应服务地址', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-greeting-model-'))
  try {
    const configPath = join(root, 'config.json'), masterKey = 'synthetic-greeting-master'
    await writeFile(configPath, JSON.stringify({ ai: { provider: 'openai', base_url: 'https://platform.example.test/v1', model: 'platform-model', api_key: 'platform-key' },
      ai_presets: { strategy: 'pool', pool_mode: 'round_robin', items: [
        { id: 'preset-a', provider: 'openai', base_url: 'https://platform.example.test/v1', model: 'pool-model-a', api_key: 'platform-key', in_pool: true },
      ] } }))
    const sealed = encryptByokEnvelope('synthetic-user-key', masterKey, 1)
    const credential: ByokCredential = { provider: 'deepseek', api_format: '', base_url: '', model: 'user-model',
      encrypted_value: sealed.ciphertext, nonce: sealed.nonce, encrypted_data_key: sealed.encryptedDataKey, key_version: sealed.keyVersion,
      max_tokens: null, context_tokens: null, thinking: null, reasoning_effort: null, reasoning_persistence: 'off',
      image: false, video: false, audio: false, image_detail: 'auto', web_search_enabled: false }
    const queries: unknown[][] = []
    const pool = { async query(_sql: string, values: unknown[]) { queries.push(values); return { rows: [credential] } } }
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null, closed = false
    const complete = createStandaloneGreetingCompleter(pool as never, configPath, { CREDENTIALS_MASTER_KEY: masterKey }, () => ({
      async request(request) {
        captured = { url: request.url, headers: request.headers as Record<string, string>, body: request.body }
        const body = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '你好，今天想聊什么？' }, finish_reason: 'stop' }] }))
        return { status: 200, headers: { 'content-type': 'application/json' }, body: (async function* () { yield body })(), cancel() {} }
      }, async close() { closed = true },
    }))
    const result = await complete(owner, '合成问候提示词', 180, new AbortController().signal)
    assert.equal(result, '你好，今天想聊什么？')
    assert.deepEqual(queries, [[owner, 'llm']])
    assert.equal(captured?.url, 'https://api.deepseek.com/chat/completions')
    assert.equal(captured?.headers.Authorization, 'Bearer synthetic-user-key')
    const body = captured?.body as { model?: string; max_tokens?: number; messages?: Array<{ content?: unknown }> }
    assert.equal(body.model, 'user-model')
    assert.equal(body.max_tokens, 180)
    assert.ok(JSON.stringify(body.messages).includes('合成问候提示词'))
    assert.equal(closed, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
