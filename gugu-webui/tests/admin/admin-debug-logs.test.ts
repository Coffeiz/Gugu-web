import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminDebugLogRoutes } from '../../src/domains/admin/admin-debug-logs.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-admin-debug-'))
  const paths = { web: join(root, 'web.log'), worker: join(root, 'worker.log'), gateway: join(root, 'gateway.log') }
  let resolveCount = 0
  const guardedPaths = new Proxy(paths, { get(target, key: string) { resolveCount += 1; return target[key as keyof typeof target] } })
  const app = Fastify()
  registerAdminDebugLogRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    verifyAdmin: async () => true,
    paths: guardedPaths,
    webCandidates: [join(root, 'web-dev.log'), paths.web],
  })
  return {
    app, root, paths,
    get resolveCount() { return resolveCount },
    cleanup: async () => { await app.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('未授权请求在任何日志路径解析前被拒绝', async () => {
  const ctx = await setup()
  try {
    await writeFile(ctx.paths.web, 'sensitive synthetic log\n')
    const response = await ctx.app.inject({ url: '/api/v1/admin/debug/logs/tail' })
    assert.equal(response.statusCode, 401)
    assert.equal(ctx.resolveCount, 0)
    assert.equal((await readFile(ctx.paths.web, 'utf8')).includes('sensitive synthetic log'), true)
  } finally { await ctx.cleanup() }
})

test('无效source回退所有日志并按事件时间稳定归并', async () => {
  const ctx = await setup()
  try {
    await writeFile(ctx.paths.web, '11-12 10:00:00 web earlier\n11-12 10:02:00 web later\n')
    await writeFile(ctx.paths.worker, '11-12 10:01:00 worker middle\n')
    const response = await ctx.app.inject({ url: '/api/v1/admin/debug/logs/tail?source=invalid&lines=10', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().lines.map((row: { source: string; line: string }) => `${row.source}:${row.line}`), [
      'web:11-12 10:00:00 web earlier', 'worker:11-12 10:01:00 worker middle', 'web:11-12 10:02:00 web later',
    ])
    assert.deepEqual(response.json().lines.map((row: { time: string }) => row.time), ['11-12 10:00:00', '11-12 10:01:00', '11-12 10:02:00'])
  } finally { await ctx.cleanup() }
})

test('cursor按UTF-8字节分页、可重放且日志轮转后仍容错', async () => {
  const ctx = await setup()
  try {
    await writeFile(ctx.paths.worker, '最旧\n旧页一\n旧页二\n最新一\n最新二\n')
    const latest = await ctx.app.inject({ url: '/api/v1/admin/debug/logs/tail?source=worker&lines=2', headers: { authorization: 'admin' } })
    const cursor = latest.json().next_cursor as string
    assert.equal(latest.statusCode, 200)
    assert.match(cursor, /^[A-Za-z0-9_-]+$/)
    assert.deepEqual(latest.json().lines.map((row: { line: string }) => row.line), ['最新一', '最新二'])
    const older = await ctx.app.inject({ url: `/api/v1/admin/debug/logs/tail?source=worker&lines=2&cursor=${cursor}`, headers: { authorization: 'admin' } })
    const replay = await ctx.app.inject({ url: `/api/v1/admin/debug/logs/tail?source=worker&lines=2&cursor=${cursor}`, headers: { authorization: 'admin' } })
    assert.deepEqual(older.json().lines.map((row: { line: string }) => row.line), ['旧页一', '旧页二'])
    assert.deepEqual(replay.json(), older.json())
    await writeFile(ctx.paths.worker, 'rotated single line\n')
    const afterRotation = await ctx.app.inject({ url: `/api/v1/admin/debug/logs/tail?source=worker&lines=2&cursor=${cursor}`, headers: { authorization: 'admin' } })
    assert.equal(afterRotation.statusCode, 200)
    assert.ok(Array.isArray(afterRotation.json().lines))
  } finally { await ctx.cleanup() }
})

test('过滤结果不足一页时继续向前读取，traceback跨页继承父行时间', async () => {
  const ctx = await setup()
  try {
    await writeFile(ctx.paths.web, [
      '11-12 09:00:00 ERROR needle older',
      'Traceback (most recent call last):',
      '  File "合成.py", line 2',
      '11-12 09:01:00 INFO unrelated one',
      '11-12 09:02:00 INFO unrelated two',
      '11-12 09:03:00 INFO needle newest',
      '',
    ].join('\n'))
    const response = await ctx.app.inject({ url: '/api/v1/admin/debug/logs/tail?source=web&lines=2&query=needle', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().lines.map((row: { line: string }) => row.line), [
      '11-12 09:00:00 ERROR needle older', '11-12 09:03:00 INFO needle newest',
    ])
    const continuation = await ctx.app.inject({ url: '/api/v1/admin/debug/logs/tail?source=web&lines=2&cursor=' + response.json().next_cursor, headers: { authorization: 'admin' } })
    assert.equal(continuation.statusCode, 200)
  } finally { await ctx.cleanup() }
})

test('游标页从traceback续行开始时仍继承上一页的异常时间', async () => {
  const ctx = await setup()
  try {
    await writeFile(ctx.paths.worker, [
      '11-12 08:00:00 ERROR request failed',
      'Traceback (most recent call last):',
      '  File "worker.py", line 1',
      '11-12 08:01:00 INFO recovered',
      '',
    ].join('\n'))
    const page = await ctx.app.inject({ url: '/api/v1/admin/debug/logs/tail?source=worker&lines=2', headers: { authorization: 'admin' } })
    assert.deepEqual(page.json().lines.map((row: { line: string; time: string }) => [row.line, row.time]), [
      ['  File "worker.py", line 1', '11-12 08:00:00'],
      ['11-12 08:01:00 INFO recovered', '11-12 08:01:00'],
    ])
  } finally { await ctx.cleanup() }
})

test('web候选按mtime选择；非法cursor回到最新页，lines遵守范围', async () => {
  const ctx = await setup()
  try {
    const dev = join(ctx.root, 'web-dev.log')
    await writeFile(dev, 'dev candidate\n')
    await writeFile(ctx.paths.web, 'configured candidate\n')
    const old = new Date('2026-01-01T00:00:00Z'), fresh = new Date('2026-01-02T00:00:00Z')
    await utimes(dev, old, old)
    await utimes(ctx.paths.web, fresh, fresh)
    const selected = await ctx.app.inject({ url: '/api/v1/admin/debug/logs/tail?source=web&lines=1', headers: { authorization: 'admin' } })
    assert.equal(selected.json().lines[0].line, 'configured candidate')
    const malformed = await ctx.app.inject({ url: '/api/v1/admin/debug/logs/tail?source=web&cursor=%%%&lines=1', headers: { authorization: 'admin' } })
    assert.equal(malformed.statusCode, 200)
    for (const lines of [0, 501]) {
      const invalid = await ctx.app.inject({ url: `/api/v1/admin/debug/logs/tail?lines=${lines}`, headers: { authorization: 'admin' } })
      assert.equal(invalid.statusCode, 400)
    }
    await writeFile(ctx.paths.gateway, Array.from({ length: 205 }, (_, index) => `line ${index}`).join('\n'))
    const defaultPage = await ctx.app.inject({ url: '/api/v1/admin/debug/logs/tail?source=gateway', headers: { authorization: 'admin' } })
    assert.equal(defaultPage.statusCode, 200)
    assert.equal(defaultPage.json().lines.length, 200)
  } finally { await ctx.cleanup() }
})


test('SSE从连接时的日志末尾开始读取，持续发出新增行并只解析白名单source', async () => {
  const ctx = await setup()
  const controller = new AbortController()
  let verifyCalls = 0
  // 重新注册单独的SSE路由以验证每轮都会重新核验管理员身份。
  await ctx.app.close()
  const app = Fastify()
  registerAdminDebugLogRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    paths: ctx.paths,
    webCandidates: [join(ctx.root, 'web-dev.log'), ctx.paths.web],
    verifyAdmin: async () => { verifyCalls++; return true },
    pollIntervalMs: 100,
  })
  try {
    await writeFile(ctx.paths.worker, '11-12 09:00:00 existing\n')
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await fetch(`${address}/api/v1/admin/debug/logs/stream?source=worker`, {
      headers: { authorization: 'admin' }, signal: controller.signal,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = response.body!.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value), /keepalive/)
    await appendFile(ctx.paths.worker, '\u001b[31m11-12 09:01:00 added\u001b[0m\n')
    let event = ''
    for (let attempt = 0; attempt < 10 && !event.includes('added'); attempt++) {
      const part = await reader.read()
      event += new TextDecoder().decode(part.value)
    }
    assert.match(event, /"source":"worker"/)
    assert.match(event, /11-12 09:01:00 added/)
    assert.ok(verifyCalls >= 2)
    controller.abort()
    const callsAtDisconnect = verifyCalls
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(verifyCalls, callsAtDisconnect)
  } finally {
    controller.abort()
    await app.close()
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('SSE在管理员身份失效后停止轮询并结束流', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-admin-debug-stream-'))
  const paths = { web: join(root, 'web.log'), worker: join(root, 'worker.log'), gateway: join(root, 'gateway.log') }
  let verifyCalls = 0
  const app = Fastify()
  registerAdminDebugLogRoutes(app, {
    requireAdmin: async (_request, _reply) => {}, paths, webCandidates: [paths.web],
    verifyAdmin: async () => ++verifyCalls < 2,
    pollIntervalMs: 10,
  })
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await fetch(`${address}/api/v1/admin/debug/logs/stream?source=worker`, { headers: { authorization: 'admin' } })
    const reader = response.body!.getReader()
    let body = ''
    for (let attempt = 0; attempt < 5; attempt++) {
      const part = await reader.read()
      if (part.done) break
      body += new TextDecoder().decode(part.value)
    }
    assert.match(body, /keepalive/)
    assert.equal(verifyCalls, 2)
    assert.equal((await reader.read()).done, true)
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
