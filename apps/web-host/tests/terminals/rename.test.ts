import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { createPostgresTerminalRenamer } from '../../src/domains/terminals/persistence/rename.js'
import { registerTerminalRenameRoute } from '../../src/modules/terminals/rename.js'
import { registerTerminalCommandRoutes } from '../../src/modules/terminals/command.js'
import { createTerminalShellExecution } from '../../src/modules/terminals/shell-execution.js'
import { createTerminalLiveOutput } from '../../src/modules/terminals/live-output.js'
import { createHostTerminalCommandService } from '../../src/modules/terminals/command-service.js'
import { createTerminalInputAuthorizer } from '../../src/modules/terminals/input-authorization.js'
import { createTerminalCancellationMarkers } from '../../src/modules/terminals/cancellation-redis.js'
import { createTerminalActiveLease } from '../../src/modules/terminals/active-lease.js'
import { createTerminalRuntimeSettingsReader } from '../../src/modules/terminals/runtime-settings.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const owner = '00000000-0000-4000-8000-000000000161'
const other = '00000000-0000-4000-8000-000000000162'
const coreRequire = createRequire(new URL('../../../../packages/core/package.json', import.meta.url))
const Database = coreRequire('better-sqlite3').default ?? coreRequire('better-sqlite3')
const { Kysely, SqliteDialect } = coreRequire('kysely')

test('只有活动租约可被取消，错误 token 不能续期或释放', async () => {
  const values = new Map<string, string>()
  const redis = {
    async set(key: string, value: string) { if (values.has(key)) return null; values.set(key, value); return 'OK' },
    async exists(key: string) { return Number(values.has(key)) },
    async eval(script: string, count: number, ...args: string[]) {
      if (count === 2) { if (!values.has(args[0]!)) return 0; values.set(args[1]!, '1'); return 1 }
      if (values.get(args[0]!) !== args[1]) return 0
      if (script.includes('DEL')) values.delete(args[0]!)
      return 1
    },
  }
  const lease = createTerminalActiveLease(redis)
  assert.equal(await lease.cancel(owner, 'mine', 'r'), false)
  const token = await lease.acquire(owner, 'mine', 'r')
  assert.ok(token)
  assert.equal(await lease.renew(owner, 'mine', 'r', 'wrong'), false)
  assert.equal(await lease.release(owner, 'mine', 'r', 'wrong'), false)
  assert.equal(await lease.cancel(owner, 'mine', 'r'), true)
  assert.equal(await lease.release(owner, 'mine', 'r', token), true)
  assert.equal(await lease.cancel(owner, 'mine', 'r'), false)
})

test('跨实例取消标记按 owner、终端和请求隔离', async () => {
  const values = new Map<string, string>()
  const redis = { async get(key: string) { return values.get(key) ?? null }, async set(key: string, value: string) { values.set(key, value); return true }, async publish() { return 0 } }
  const first = createTerminalCancellationMarkers(redis), second = createTerminalCancellationMarkers(redis)
  await first.request(owner, 'one', 'request')
  assert.equal(await second.isRequested(owner, 'one', 'request'), true)
  assert.equal(await second.isRequested(other, 'one', 'request'), false)
  assert.equal(await second.isRequested(owner, 'two', 'request'), false)
  assert.equal(await second.isRequested(owner, 'one', 'other'), false)
})

test('终端执行配置读取管理员覆盖并拒绝无效网络策略', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-terminal-settings-'))
  const file = join(dir, 'settings.json')
  try {
    await writeFile(file, JSON.stringify({ sandbox: { enabled: false, network_profile: 'egress' }, agent: { shell_enabled: false } }))
    const read = createTerminalRuntimeSettingsReader(file, { SANDBOX__ENABLED: 'true' }, async () => ({ supported: true }))
    assert.match(JSON.stringify(await read()), /"sandboxEnabled":false/)
    assert.equal((await read()).networkProfile, 'egress')
    assert.equal((await read()).sandboxReady, false)
    await writeFile(file, '{}')
    assert.equal((await read()).networkProfile, 'egress')
    const nested = createTerminalRuntimeSettingsReader(file, { SANDBOX: '{"network_profile":"none","enabled":false}' }, async () => ({ supported: true }))
    assert.equal((await nested()).networkProfile, 'none')
    assert.equal((await nested()).sandboxEnabled, false)
    await writeFile(file, JSON.stringify({ sandbox: { network_profile: 'egress', egress_proxy_url: 'http://127.0.0.1:3128' } }))
    assert.equal((await read()).egressProxyUrl, 'http://127.0.0.1:3128')
    const egressReady = createTerminalRuntimeSettingsReader(file, {}, async () => ({ supported: true, proxyEnforcement: true }))
    assert.equal((await egressReady()).sandboxReady, true)
    const missingProxyEnforcement = createTerminalRuntimeSettingsReader(file, {}, async () => ({ supported: true, proxyEnforcement: false }))
    assert.equal((await missingProxyEnforcement()).sandboxReady, false)
    await writeFile(file, JSON.stringify({ sandbox: { network_profile: 'egress', egress_proxy_url: 'http://proxy.example:3128' } }))
    assert.equal((await read()).sandboxReady, false)
    assert.match((await read()).egressProxyError ?? '', /MXC 代理必须是本机回环 HTTP\/S 地址/)
    await writeFile(file, JSON.stringify({ sandbox: { network_profile: 'unsafe' } }))
    await assert.rejects(read(), /网络配置无效/)
    await writeFile(file, '{invalid')
    await assert.rejects(read(), /配置文件损坏/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('终端输入逐次检查 owner、PTY 开关和 Shell 能力', async () => {
  let enabled = true
  const authorize = createTerminalInputAuthorizer({
    read: async (candidate) => { if (candidate !== owner) throw Object.assign(new Error('终端不存在'), { statusCode: 404 }); return { mode: 'agent-events', sessionId: 1 } as never },
    snapshot: async () => ({ facts: { adminEnabled: true, userEnabled: enabled, sandboxEnabled: true, sandboxReady: true,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true } }),
    ptyEnabled: () => false,
  })
  await authorize(owner, 'mine')
  await assert.rejects(authorize(other, 'mine'), { statusCode: 404 })
  enabled = false
  await assert.rejects(authorize(owner, 'mine'), { statusCode: 403 })
})

test('Host 命令组合提交 running 后发送事件并执行', async () => {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(id TEXT,owner_id TEXT,last_sequence INTEGER,output_chars INTEGER,status TEXT,updated_at TEXT,closed_at TEXT,
    name TEXT,session_id INTEGER,run_id TEXT,workspace_id INTEGER,source TEXT,mode TEXT,shell_mode TEXT,network_profile TEXT,pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,created_at TEXT);
    CREATE TABLE terminal_events(id INTEGER PRIMARY KEY,terminal_id TEXT,run_id TEXT,sequence INTEGER,event_type TEXT,source TEXT,command TEXT,stdout TEXT,stderr TEXT,exit_code INTEGER,occurred_at TEXT);
    INSERT INTO terminal_sessions VALUES('mine','${owner}',0,0,'idle','',NULL,'终端',NULL,NULL,NULL,'user','agent-events','sandbox','none',NULL,NULL,NULL,NULL,'2026-01-01')`)
  const observed: string[] = []
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const service = createHostTerminalCommandService({ db, authorize: async () => {}, read: async () => ({ id: 'mine' } as never),
    publisher: { async publishResourceChanged(input) { observed.push(String((input.payload as { event: { type: string } }).event.type)); if (observed.length === 2) finish(); return true } },
    execute: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, ok: true }), diagnose: () => { throw new Error('unexpected') } })
  try {
    const result = await service.start(owner, 'mine', { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' })
    await done
    assert.equal(result.event.type, 'status')
    assert.equal(result.terminal.lastSequence, 1)
    assert.equal(result.terminal.status, 'running')
    assert.deepEqual(observed, ['status', 'command'])
    assert.equal(native.prepare('SELECT last_sequence FROM terminal_sessions').get().last_sequence, 2)
  } finally { await db.destroy(); native.close() }
})

test('读取终端失败时不提交事件或启动命令', async () => {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  let runs = 0
  const service = createHostTerminalCommandService({ db, authorize: async () => {}, read: async () => { throw new Error('读取失败') },
    publisher: { async publishResourceChanged() { return true } }, execute: async () => { runs++; return { stdout: '', stderr: '', exitCode: 0, ok: true } }, diagnose: () => {} })
  try {
    await assert.rejects(service.start(owner, 'mine', { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' }))
    assert.equal(runs, 0)
  } finally { await db.destroy(); native.close() }
})

test('实时输出按 owner 发送 Python 兼容的临时事件', async () => {
  let sent: unknown
  const publish = createTerminalLiveOutput({ async publishResourceChanged(input) { sent = input; return true } }, () => new Date('2026-01-01T00:00:00Z'))
  await publish(owner, 'mine', 'request', 'pwd', 'stderr', 'error')
  assert.deepEqual(sent, { ownerId: owner, resource: 'terminals', operation: 'append', entityId: 'mine', payload: {
    terminal_id: 'mine', event: { sequence: 0, type: 'output', source: 'user', runId: 'request', command: 'pwd', stdout: '', stderr: 'error', exitCode: null, occurredAt: '2026-01-01T00:00:00.000Z' },
  } })
})

test('危险 Shell 命令在执行前检查开关并消费确认', async () => {
  let runs = 0, confirmations = 0
  const facts = { adminEnabled: true, userEnabled: true, sandboxEnabled: true, sandboxReady: true, sessionOwned: true,
    workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true }
  const execute = createTerminalShellExecution({
    read: async () => ({ facts, sessionId: 1, workspaceId: null }), redeem: async () => true,
    confirm: async () => { confirmations++; return { allowed: false, error: '需要确认' } },
    run: async () => { runs++; return { stdout: '', stderr: '', exitCode: 0, ok: true } },
  })
  const result = await execute(owner, 'mine', 'request', { command: 'rm -rf tmp', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' }, new AbortController().signal)
  assert.equal(result.stderr, '需要确认')
  assert.equal(confirmations, 1)
  assert.equal(runs, 0)
})

test('管理员配置了受 MXC 限制的回环代理时，后台 egress 通过生产执行端运行', async () => {
  let runs = 0
  const execute = createTerminalShellExecution({
    read: async () => ({ sessionId: 1, workspaceId: null, networkProfile: 'egress', egressProxyUrl: 'http://127.0.0.1:3128', facts: { adminEnabled: true, userEnabled: true, sandboxEnabled: true, sandboxReady: true,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true } }),
    redeem: async () => true, confirm: async () => ({ allowed: true }),
    run: async (_owner, _terminal, _id, _input, snapshot) => { runs++; assert.equal(snapshot.egressProxyUrl, 'http://127.0.0.1:3128'); return { stdout: '', stderr: '', exitCode: 0, ok: true } },
  })
  const result = await execute(owner, 'mine', 'request', { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' }, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(runs, 1)
})

test('请求级 egress 在 MXC 未实现受控出站时拒绝执行，不静默降级为断网', async () => {
  let runs = 0
  const execute = createTerminalShellExecution({
    read: async () => ({ sessionId: null, workspaceId: null, networkProfile: 'none', facts: { adminEnabled: true, userEnabled: true, sandboxEnabled: true, sandboxReady: true,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true } }),
    redeem: async () => true, confirm: async () => ({ allowed: true }),
    run: async () => { runs++; return { stdout: '', stderr: '', exitCode: 0, ok: true } },
  })
  const result = await execute(owner, 'mine', 'request', { command: 'curl https://example.invalid', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'egress' }, new AbortController().signal)
  assert.equal(result.stderr, '受控 egress 尚未配置，当前沙盒保持断网')
  assert.equal(runs, 0)
})

test('确认期间撤销 Shell 权限时不执行命令', async () => {
  let enabled = true, runs = 0
  const execute = createTerminalShellExecution({
    read: async () => ({ sessionId: 1, workspaceId: null, facts: { adminEnabled: true, userEnabled: enabled, sandboxEnabled: true, sandboxReady: true,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true } }),
    redeem: async () => true, confirm: async () => { enabled = false; return { allowed: true } },
    run: async () => { runs++; return { stdout: '', stderr: '', exitCode: 0, ok: true } },
  })
  const result = await execute(owner, 'mine', 'request', { command: 'rm -rf tmp', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' }, new AbortController().signal)
  assert.equal(result.stderr, 'Shell 权限已变更，命令已中止')
  assert.equal(runs, 0)
})

test('运行中撤销权限会中止执行并返回可见错误', async () => {
  let reads = 0, aborted = false
  const execute = createTerminalShellExecution({
    read: async () => ({ sessionId: 1, workspaceId: null, facts: { adminEnabled: true, userEnabled: ++reads < 3, sandboxEnabled: true, sandboxReady: true,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true } }),
    redeem: async () => true, confirm: async () => ({ allowed: true }),
    run: async (_owner, _terminal, _id, _input, _snapshot, _confirmed, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')) }, { once: true })
    }),
  }, 5)
  const result = await execute(owner, 'mine', 'request', { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' }, new AbortController().signal)
  assert.equal(aborted, true)
  assert.equal(result.stderr, 'Shell 权限已变更，命令已中止')
})

test('另一实例的取消标记中止匹配命令', async () => {
  let checks = 0
  const execute = createTerminalShellExecution({
    read: async () => ({ sessionId: 1, workspaceId: null, facts: { adminEnabled: true, userEnabled: true, sandboxEnabled: true, sandboxReady: true,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true } }),
    redeem: async () => true, confirm: async () => ({ allowed: true }), isCancelled: async () => ++checks >= 3,
    run: async (_owner, _terminal, _id, _input, _snapshot, _confirmed, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    }),
  }, 5)
  const result = await execute(owner, 'mine', 'request', { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' }, new AbortController().signal)
  assert.equal(result.stderr, '命令已取消')
})

test('工作区标识不变但目标变更时不执行已确认命令', async () => {
  let target = 'one', runs = 0
  const execute = createTerminalShellExecution({
    read: async () => ({ sessionId: 1, workspaceId: 7, workspaceTarget: target, facts: { adminEnabled: true, userEnabled: true, sandboxEnabled: true, sandboxReady: true,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true } }),
    redeem: async () => true, confirm: async () => { target = 'two'; return { allowed: true } },
    run: async () => { runs++; return { stdout: '', stderr: '', exitCode: 0, ok: true } },
  })
  const result = await execute(owner, 'mine', 'request', { command: 'rm -rf tmp', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' }, new AbortController().signal)
  assert.equal(result.ok, false)
  assert.equal(runs, 0)
})

test('危险命令确认成功后只向可信执行端传递本次确认', async () => {
  let seen = false
  const execute = createTerminalShellExecution({
    read: async () => ({ sessionId: 1, workspaceId: null, facts: { adminEnabled: true, userEnabled: true, sandboxEnabled: true, sandboxReady: true,
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true } }),
    redeem: async () => true, confirm: async () => ({ allowed: true }),
    run: async (_owner, _terminal, _id, _input, _snapshot, confirmed) => { seen = confirmed; return { stdout: '', stderr: '', exitCode: 0, ok: true } },
  })
  const result = await execute(owner, 'mine', 'request', { command: 'rm -rf tmp', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' }, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(seen, true)
})

test('命令路由校验输入并忽略客户端自报确认', async () => {
  const app = Fastify()
  installHttpErrorHandler(app)
  let received: unknown
  registerTerminalCommandRoutes(app, {
    requireUser: async (request, reply) => { if (!request.headers.authorization) return reply.code(401).send({ detail: '未授权' }) },
    ownerIdFromRequest: () => owner,
    start: async (_owner, _terminal, input) => { received = input; return { terminal: {} as never, requestId: 'r', event: {} as never } },
    cancel: async () => ({ cancelled: false }),
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/terminals/a/input', payload: { command: 'pwd' } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/terminals/a/input', headers: { authorization: 'test' }, payload: { command: 'pwd', network: 'bad' } })).statusCode, 422)
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/terminals/a/input', headers: { authorization: 'test' }, payload: { command: 'pwd', confirm: true } })).statusCode, 200)
    assert.deepEqual(received, { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 12000, network: 'none' })
  } finally { await app.close() }
})

function setup() {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL);
  INSERT INTO conversation_sessions VALUES(91,'${owner}');
  INSERT INTO terminal_sessions VALUES('mine','${owner}',91,101,NULL,'原名','user','interactive-pty','idle','sandbox','none',0,0,NULL,NULL,NULL,NULL,'2026-11-17T00:00:00.000Z','2026-11-17T00:00:00.000Z',NULL);
  INSERT INTO terminal_sessions VALUES('foreign','${other}',91,NULL,NULL,'foreign','user','interactive-pty','idle','sandbox','none',0,0,NULL,NULL,NULL,NULL,'2026-11-17T00:00:00.000Z','2026-11-17T00:00:00.000Z',NULL);`)
  const pool = { async query() { return { rows: [{ data_json: { shell_enabled: true } }] } } }
  const changes: unknown[][] = []
  const app = Fastify()
  installHttpErrorHandler(app)
  const rename = createPostgresTerminalRenamer(pool as never, db, {
    terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false,
    async readSandboxReadiness() { return { ready: true } },
  }, async (...args) => { changes.push(args) })
  registerTerminalRenameRoute(app, {
    requireUser: async (request, reply) => { if (request.headers.authorization !== 'synthetic-user') return reply.code(401).send({ detail: '未授权' }) },
    ownerIdFromRequest: () => owner,
    rename: (ownerId, terminalId, input) => rename(ownerId, terminalId, { ...input, settings: {
      sandboxReady: true, terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false,
    }, preferences: { shell_enabled: true } }),
  })
  return { app, db, native, changes }
}

test('认证重命名持久化 DTO 并在提交后发布 terminals update', async () => {
  const { app, db, native, changes } = setup()
  try {
    const unauthorized = await app.inject({ method: 'PATCH', url: '/api/v1/terminals/mine', payload: { name: '新名' } })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(native.prepare('SELECT name FROM terminal_sessions WHERE id=?').get('mine')?.name, '原名')
    const result = await app.inject({ method: 'PATCH', url: '/api/v1/terminals/mine', headers: { authorization: 'synthetic-user', 'x-client-id': 'web-1' }, payload: { name: '  新名字  ' } })
    assert.equal(result.statusCode, 200)
    assert.equal(result.json().name, '新名字')
    assert.deepEqual(changes, [[owner, 'mine', 'web-1']])
    assert.equal(native.prepare('SELECT name FROM terminal_sessions WHERE id=?').get('mine')?.name, '新名字')
  } finally { await app.close(); await db.destroy() }
})

test('重命名沿用 Python 422/400/404 和 owner/Shell 边界', async () => {
  const { app, db } = setup()
  try {
    const missingName = await app.inject({ method: 'PATCH', url: '/api/v1/terminals/mine', headers: { authorization: 'synthetic-user' }, payload: {} })
    assert.equal(missingName.statusCode, 422)
    const blankName = await app.inject({ method: 'PATCH', url: '/api/v1/terminals/mine', headers: { authorization: 'synthetic-user' }, payload: { name: '   ' } })
    assert.equal(blankName.statusCode, 400)
    assert.equal(blankName.json().detail, '终端名称不能为空')
    const hidden = await app.inject({ method: 'PATCH', url: '/api/v1/terminals/foreign', headers: { authorization: 'synthetic-user' }, payload: { name: '新名' } })
    assert.equal(hidden.statusCode, 404)
  } finally { await app.close(); await db.destroy() }
})
