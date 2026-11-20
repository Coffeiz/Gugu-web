import assert from 'node:assert/strict'
import test from 'node:test'
import { createCanvas } from '@napi-rs/canvas'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { ProviderError, type ProviderHttpRequest, type ProviderTransport } from '@gugu/core/providers'
import { createAgentRunner, type AgentRunnerPorts, type RunCheckpoint } from '@gugu/core/agent'
import { createWebAgentConfirmationAuthorization } from '../../src/modules/agent/tools/confirm.js'
import type { ContextSourceSelection } from '@gugu/core/agent'
import { createHttpGetTool, createToolRegistry } from '@gugu/core/tools'
import { createPublicAgentEgress } from '../../src/adapters/network/safe-egress-proxy.js'
import { createWebAgentHttpGetPort, createWebAgentSearchPorts, verifySearchImage } from '../../src/modules/agent/tools/search.js'

const identity = { ownerId: 'owner-search', sessionId: '5', runId: 'run-search' }
const scope = {
  identity, roundId: 'round-search', signal: new AbortController().signal, resolution: null,
  async execute() { throw new Error('搜索不需要执行宿主进程') },
}
const defaultOptions: Parameters<typeof createWebAgentSearchPorts>[0] = {
  identity,
  binding: {
    selection: { modelIdentity: 'selected-search-model' } as ContextSourceSelection,
    async resolve(request, modelIdentity) {
      assert.deepEqual(request, identity)
      assert.equal(modelIdentity, 'selected-search-model')
      return { modelIdentity, accessScopeHash: 'scope', systemPrompt: '', config: {
        provider: 'ollama', model: 'synthetic', base_url: 'https://ollama.com', api_key: 'synthetic', web_search_enabled: true,
      } }
    },
  },
  readSafeEgress: () => ({ enabled: false, proxy_auth_secret: '', proxy_url: '' }),
  secretKey: 'synthetic-secret',
  digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
}

test('可信网络配置无效时保持搜索工具关闭，正常时仅公布模型支持的原生搜索', async () => {
  const valid = await createWebAgentSearchPorts(defaultOptions)
  assert.equal(valid.webSearch?.definition.name, 'web_search')
  assert.equal(typeof valid.httpGet?.get, 'function')
  assert.equal(valid.deepResearch, undefined)
  assert.deepEqual(await createWebAgentSearchPorts({
    ...defaultOptions, readSafeEgress: () => ({ enabled: true, proxy_auth_secret: '', proxy_url: 'file:///private' }),
  }), {})
})

test('Node 搜索用量迁移未应用时保留基础搜索并关闭付费搜索能力', async () => {
  const ports = await createWebAgentSearchPorts({
    ...defaultOptions,
    egress: { assertConfigured() {}, async withTransport() { throw new Error('不应发起出站请求') } },
    research: {
      schemaApplied: false,
      pool: { async query() { throw new Error('迁移关闭时不应查询搜索用量表') } } as never,
      readConfig: () => ({}), environment: {}, keyForVersion: () => '', timezone: 'UTC',
    },
  })
  assert.equal(ports.webSearch?.definition.name, 'web_search')
  assert.equal(ports.deepResearch, undefined)
  assert.equal(ports.similarImageSearch, undefined)
})

test('http_get 通过安全公网传输读取 HTML，保留链接并删除页面脚本和导航', async () => {
  const requests: ProviderHttpRequest[] = []
  const html = `<html><body><nav>导航机密噪音</nav><article><h1>合成来源</h1><p>${'可见正文。'.repeat(18)} <a href="https://example.test/source">原文</a></p><script>private-script()</script></article></body></html>`
  const transport: ProviderTransport = {
    async request(request) {
      requests.push(request)
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: (async function* () {
        yield new TextEncoder().encode(html)
      })(), async cancel() {} }
    },
    async close() {},
  }
  const ports = await createWebAgentSearchPorts({
    ...defaultOptions,
    egress: { assertConfigured() {}, async withTransport(_signal, execute) { return execute(transport) } },
  })
  assert.ok(ports.httpGet)
  const registry = createToolRegistry({
    tools: [createHttpGetTool(ports.httpGet)],
    authorize: async candidate => candidate.ownerId === identity.ownerId,
  })
  const result = await registry.tools.dispatch({ id: 'http-read', name: 'http_get', input: {
    url: 'https://example.test/page', headers: { 'X-Locale': 'zh-CN' },
  } }, scope)
  assert.deepEqual(requests.map(request => ({ url: request.url, method: request.method, headers: request.headers })), [
    { url: 'https://example.test/page', method: 'GET', headers: { 'user-agent': 'curl/8', 'x-locale': 'zh-CN' } },
  ])
  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') return
  const value = result.value as { body: string; url: string; content_type: string }
  assert.equal(value.url, 'https://example.test/page')
  assert.equal(value.content_type, 'text/html')
  assert.match(value.body, /\[原文\]\(https:\/\/example\.test\/source\)/u)
  assert.doesNotMatch(value.body, /导航机密噪音|private-script/u)
})

test('http_get 总时限耗尽时终止重试并报告超时', async t => {
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  let attempts = 0
  const port = createWebAgentHttpGetPort({
    async withTransport() {
      attempts++
      deadline.abort()
      throw new ProviderError('network', { retryable: true })
    },
  })
  await assert.rejects(port.get({ ownerId: identity.ownerId, url: 'https://example.test', maxChars: 100 },
    scope.signal), { code: 'timeout' })
  assert.equal(attempts, 1)
})

test('Web 搜索端口经 Core Harness 分派，并把结果带入下一轮 Provider 上下文', async () => {
  const requests: ProviderHttpRequest[] = []
  const transport: ProviderTransport = {
    async request(request) {
      requests.push(request)
      return { status: 200, headers: {}, body: (async function* () {
        yield new TextEncoder().encode(JSON.stringify({ results: [{ title: '合成搜索来源', url: 'https://example.invalid/source', snippets: ['受控搜索结果'] }] }))
      })(), async cancel() {} }
    },
    async close() {},
  }
  const search = await createWebAgentSearchPorts({
    ...defaultOptions,
    egress: { assertConfigured() {}, async withTransport(_signal, execute) { return execute(transport) } },
  })
  assert.ok(search.webSearch)
  const toolRegistry = createToolRegistry({
    authorize: async candidate => candidate.ownerId === identity.ownerId && candidate.sessionId === identity.sessionId,
    tools: [search.webSearch],
  })
  let checkpoint: RunCheckpoint<string[]> | null = null
  const providerContexts: string[][] = []
  const ports: AgentRunnerPorts<string[]> = {
    clock: { now: () => '2026-11-18T00:00:00.000Z' },
    store: {
      async read() { return checkpoint },
      async create(state) { checkpoint = structuredClone(state) },
      async commit(change) { checkpoint = structuredClone(change.checkpoint) },
      async pendingEvents() { return [] },
      async acknowledgeEvents() {},
    },
    leases: { async acquire() { return { token: 'synthetic-lease', fence: 1 } }, async assert() {}, async release() {} },
    cancellation: {
      async isRequested() { return false }, async request() {}, async notify() {}, async subscribe() { return () => {} },
    },
    provider: { async *stream(request) {
      providerContexts.push([...request.context])
      if (providerContexts.length === 1)
        yield { type: 'complete', text: '', calls: [{ id: 'search-call', name: 'web_search', input: { query: '合成查询' } }] }
      else yield { type: 'complete', text: '搜索完成', calls: [] }
    } },
    context: {
      assertIdentity() {}, async checkpointToolResult(_scope, result) { return result }, async restoreToolResult(_scope, result) { return result },
      async prepare() { return ['trusted-run-context'] },
      async afterRound(context, result) { return [...context, `assistant:${result.text}`] },
      async afterTool(context, call, result) { return [...context, `${call.name}:${JSON.stringify(result)}`] },
      async resumeInteraction(context) { return context }, async recoverOverflow(context) { return { context, applied: false } },
      async afterUsage(context) { return { context, applied: false } },
    },
    tools: toolRegistry.tools,
    interactions: { async activate(_identity, request) { return request } },
    execution: { async execute() { throw new Error('联网搜索不得调用宿主进程') } },
    reply: { async evaluate() { return 'accept' } },
    sanitizeText: text => text,
    createStreamSanitizer: () => ({ feed: text => text, flush: () => '' }),
    presentError: () => ({ code: 'failed', text: '请求失败' }),
    async presentToolResult(value) { return value },
    async publish() {}, diagnose() {},
  }
  const run = createAgentRunner(ports)
  for await (const _event of run.start(identity)) { /* 等待受控的两轮 Agent Run 完成。 */ }
  assert.equal(requests.length, 1)
  assert.match(JSON.stringify(requests[0]), /合成查询/u)
  assert.equal(providerContexts.length, 2)
  assert.match(providerContexts[1]!.join('\n'), /合成搜索来源/u)
  assert.match(providerContexts[1]!.join('\n'), /受控搜索结果/u)
})

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('付费搜索通过持久认领预留额度，结果或未知状态均不得二次外呼', { skip: !databaseUrl }, async t => {
  const schema = `research_attempts_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema })
  let release!: () => void
  let notify!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { notify = resolve })
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-paid-search-'))
  let releaseImage!: () => void
  let notifyImage!: () => void
  const imageBlocked = new Promise<void>(resolve => { releaseImage = resolve })
  const imageStarted = new Promise<void>(resolve => { notifyImage = resolve })
  const requests: ProviderHttpRequest[] = []
  const transport: ProviderTransport = {
    async request(request) {
      requests.push(request)
      if (request.url.endsWith('/image_similar_info')) {
        const body = request.body as { image: string; count: number }
        assert.equal(request.headers.Authorization, 'Bearer synthetic-baidu')
        assert.ok(Buffer.from(body.image, 'base64').length > 8)
        if (body.count === 7) throw new Error('合成图片外呼断开')
        assert.equal(body.count, 15)
        notifyImage()
        await imageBlocked
        return { status: 200, headers: {}, body: (async function* () {
          yield new TextEncoder().encode(JSON.stringify({ requestId: 'synthetic-image-response', result: { res_data: { res_items: [] } } }))
        })(), async cancel() {} }
      }
      const query = (request.body as { query: string }).query
      if (query === '断线前已发出') throw new Error('合成断线')
      if (query === '已知拒绝') return { status: 403, headers: {}, body: (async function* () {})(), async cancel() {} }
      if (query === '合成研究') { notify(); await blocked }
      return { status: 200, headers: {}, body: (async function* () {
        yield new TextEncoder().encode(JSON.stringify({ answer: '正文', results: [
          { title: '合成来源', url: 'https://example.invalid/source', snippets: ['甲'.repeat(5000), '乙'.repeat(5000)] },
        ] }))
      })(), async cancel() {} }
    },
    async close() {},
  }
  try {
    const owner = randomUUID(), other = randomUUID()
    const version = 'a'.repeat(64)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,security_version integer,is_active boolean,account_status text,search_limit_daily integer);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,active_run_id text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,expires_at timestamptz);
      CREATE TABLE user_provider_credentials(id integer,user_id uuid,capability text,enabled boolean,provider text,encrypted_value text,nonce text,encrypted_data_key text,key_version integer);
      ${tablesSql('postgres').receipts}`)
    await pool.query("INSERT INTO users VALUES ($1,1,true,'active',NULL),($2,1,true,'active',NULL)", [owner, other])
    async function bind(ownerId: string, sessionId: string) {
      const id = { ownerId, sessionId, runId: `synthetic-research-${sessionId}` }
      const token = `synthetic-token-${sessionId}`
      await pool.query('INSERT INTO conversation_sessions VALUES ($1,$2,$3)', [sessionId, ownerId, id.runId])
      await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,$2,$3,'selected',$4,1,clock_timestamp()+interval '5 minutes')", [ownerId, sessionId, id.runId, token])
      await pool.query("INSERT INTO agent_run_leases VALUES ($1,$2,$3,clock_timestamp()+interval '5 minutes')", [ownerId, sessionId, id.runId])
      const lease = { identity: id, token, fence: 1, mode: 'start' as const, cancelRequested: false,
        input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion: version } }
      const authority = createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() { return version } })
      const prepared: Parameters<typeof createWebAgentSearchPorts>[0] = {
        ...defaultOptions, identity: id,
        binding: { selection: defaultOptions.binding.selection, async resolve(candidate, modelIdentity) {
          assert.deepEqual(candidate, id)
          return defaultOptions.binding.resolve(identity, modelIdentity, scope.signal)
        } },
        egress: { assertConfigured() {}, async withTransport(_signal, execute) { return execute(transport) } },
        research: { pool, schemaApplied: true, environment: {}, keyForVersion: () => '', timezone: 'Asia/Shanghai',
          imageStorageRoot: storageRoot,
          readConfig: () => ({ search: { tavily_api_key: 'synthetic', baidu_qianfan_api_key: 'synthetic-baidu', similar_image_limit_daily: 1 }, quota: { default_search_limit_daily: 1 } }),
          durable: { core, async authorize(tx, candidate, signal) {
            return (await authority.authorizeInTransaction(tx, candidate, signal))?.endsWith(`:${version}`) === true
          } },
        },
      }
      return { id, prepared }
    }
    const first = await bind(owner, '1')
    assert.equal((await createWebAgentSearchPorts(first.prepared)).deepResearch, undefined)
    await pool.query('CREATE TABLE search_usage(id serial PRIMARY KEY,user_id uuid NOT NULL,query text NOT NULL,created_at timestamptz NOT NULL)')
    const second = await bind(owner, '2'), foreign = await bind(other, '3')
    async function dispatchFor(bound: typeof first) {
      const ports = await createWebAgentSearchPorts(bound.prepared)
      assert.ok(ports.deepResearch)
      const { tools } = createToolRegistry({ tools: [ports.deepResearch], authorize: async () => true })
      const call = (query: string, callId = 'research') => ({ id: callId, name: 'deep_research', input: { query } })
      return {
        send: (query: string, callId?: string) => tools.dispatch(call(query, callId), { ...scope, identity: bound.id }),
        reconcile: (query: string) => tools.reconcile(call(query), { ...bound.id, roundId: scope.roundId }),
      }
    }
    const requester = await dispatchFor(first), peer = await dispatchFor(second)
    const initial = requester.send('合成研究')
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([started, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('外呼未启动')), 3000)
        })])
      } finally { clearTimeout(timer) }
      const exhausted = await peer.send('竞争同一额度')
      assert.ok(exhausted.kind === 'completed' && !exhausted.successful)
      assert.match(JSON.stringify(exhausted.value), /1 次\/天/u)
      assert.deepEqual(await requester.send('合成研究'), { kind: 'unknown' })
      assert.equal(requests.length, 1)
      assert.equal((await pool.query('SELECT 1 FROM search_usage')).rowCount, 0)
    } finally { release() }
    const result = await initial
    assert.ok(result.kind === 'completed' && result.successful && result.mutated)
    const value = result.value as { results: Array<{ content: string }>; _gugu_search_limits: { truncated: boolean } }
    assert.equal(value.results[0]?.content.length, 8000)
    assert.equal(value._gugu_search_limits.truncated, true)
    const expectedReplay = JSON.stringify({ ...result, mutated: false })
    assert.ok(JSON.stringify(await requester.send('合成研究')) === expectedReplay, '重复执行应返回原报告且不重发请求')
    assert.ok(JSON.stringify(await requester.reconcile('合成研究')) === expectedReplay, '恢复应返回原报告且只读收据')
    const edited = await requester.send('更改已认领参数')
    assert.ok(edited.kind === 'completed' && !edited.successful)
    assert.match(JSON.stringify(edited.value), /操作标识已用于不同内容/u)
    assert.equal(requests.length, 1)
    const notKnown = await dispatchFor(foreign)
    assert.deepEqual(await notKnown.send('断线前已发出'), { kind: 'unknown' })
    assert.deepEqual(await notKnown.send('断线前已发出'), { kind: 'unknown' })
    const reserved = await notKnown.send('未知操作仍占用额度', 'still-reserved')
    assert.ok(reserved.kind === 'completed' && !reserved.successful)
    assert.match(JSON.stringify(reserved.value), /1 次\/天/u)
    assert.equal(requests.length, 2)
    assert.deepEqual((await pool.query('SELECT user_id,query FROM search_usage')).rows, [{ user_id: owner, query: '合成研究' }])
    await pool.query('UPDATE users SET search_limit_daily=2 WHERE id=$1', [owner])
    const knownFailure = await peer.send('已知拒绝', 'rejected')
    assert.ok(knownFailure.kind === 'completed' && !knownFailure.successful)
    assert.match(JSON.stringify(knownFailure.value), /HTTP 403/u)
    assert.equal((await pool.query('SELECT 1 FROM search_usage')).rowCount, 1)
    const accepted = await peer.send('已知失败释放额度', 'replacement')
    assert.ok(accepted.kind === 'completed' && accepted.successful)
    assert.equal((await pool.query('SELECT 1 FROM search_usage')).rowCount, 2)
    await pool.query('UPDATE users SET is_active=false WHERE id=$1', [owner])
    const revoked = await peer.send('撤权后禁止外呼', 'revoked')
    assert.ok(revoked.kind === 'completed' && !revoked.successful)
    assert.match(JSON.stringify(revoked.value), /当前运行无权进行深度研究/u)
    assert.equal(requests.length, 4)

    await t.test('相似图只查本主附件，保留独立额度并与深度研究协调在途预留', async () => {
      await pool.query('UPDATE users SET is_active=true,search_limit_daily=3 WHERE id=$1', [owner])
      await pool.query(`CREATE TABLE chat_attachments(user_id uuid,attach_id text,kind text,ext text,size bigint,storage_key text,state text)`)
      const png = createCanvas(3, 4).toBuffer('image/png')
      for (const user of [owner, other]) {
        await mkdir(join(storageRoot, user), { recursive: true })
        await writeFile(join(storageRoot, user, 'synthetic.png'), png)
        await pool.query("INSERT INTO chat_attachments VALUES ($1,$2,'image','png',$3,$4,'draft')",
          [user, user === owner ? 'owned-image' : 'foreign-image', png.length, `${user}/synthetic.png`])
      }
      async function imageFor(bound: typeof first) {
        const options = { ...bound.prepared, egress: { assertConfigured() {}, async withTransport<T>(signal: AbortSignal, execute: (port: ProviderTransport) => Promise<T>) {
          // 私有地址走真实出站检查；合成 GET 模拟下载后撤权，POST 不访问付费上游。
          return execute({ ...transport, async request(request, cancellation) {
            if (request.method !== 'GET') return transport.request(request, cancellation)
            if (request.url === 'https://example.invalid/admitted.png') {
              await pool.query("UPDATE agent_run_dispatch SET state='cancelled' WHERE run_id=$1", [bound.id.runId])
              return { status: 200, headers: {}, body: (async function* () { yield png })(), async cancel() {} }
            }
            return createPublicAgentEgress(defaultOptions.readSafeEgress, defaultOptions.secretKey)
              .withTransport(signal, port => port.request(request, cancellation))
          } })
        } } }
        const ports = await createWebAgentSearchPorts(options)
        assert.ok(ports.similarImageSearch)
        const { tools } = createToolRegistry({ tools: [ports.similarImageSearch], authorize: async () => true })
        const call = (id: string, input: object) => ({ id, name: 'similar_image_search', input })
        return {
          send: (id: string, input: object) => tools.dispatch(call(id, input), { ...scope, identity: bound.id }),
          recover: (id: string, input: object) => tools.reconcile(call(id, input), { ...bound.id, roundId: scope.roundId }),
        }
      }
      const image = await imageFor(first), otherRun = await imageFor(second), unowned = await imageFor(foreign)
      const missing = await image.send('foreign-attachment', { attach_id: 'foreign-image', image_url: 'http://127.0.0.1/image.png' })
      assert.ok(missing.kind === 'completed' && !missing.successful)
      assert.match(JSON.stringify(missing.value), /找不到这个图片附件/u)
      const privateUrl = await image.send('private-url', { image_url: 'http://127.0.0.1/image.png' })
      assert.ok(privateUrl.kind === 'completed' && !privateUrl.successful)
      assert.match(JSON.stringify(privateUrl.value), /网络图片下载失败/u)
      assert.equal(requests.length, 4)
      const args = { attach_id: 'owned-image', image_url: 'http://127.0.0.1/image.png' }
      const running = image.send('paid-image', args)
      try {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([imageStarted, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('相似图外呼未启动')), 3000)
          })])
        } finally { clearTimeout(timer) }
        const imageExhausted = await otherRun.send('duplicate-slot', { attach_id: 'owned-image' })
        assert.ok(imageExhausted.kind === 'completed' && !imageExhausted.successful)
        assert.match(JSON.stringify(imageExhausted.value), /相似图搜索次数已用完/u)
        const sharedQuota = await peer.send('深度研究也计入在途相似图', 'shared-quota')
        assert.ok(sharedQuota.kind === 'completed' && !sharedQuota.successful)
        assert.match(JSON.stringify(sharedQuota.value), /3 次\/天/u)
        assert.deepEqual(await image.send('paid-image', args), { kind: 'unknown' })
        assert.equal(requests.length, 5)
      } finally { releaseImage() }
      const report = await running
      assert.ok(report.kind === 'completed' && report.successful && report.mutated)
      assert.deepEqual(JSON.parse(JSON.stringify(report.value)), {
        results: [], request_id: 'synthetic-image-response', count: 0, note: '没有找到相似结果',
      })
      assert.ok(JSON.stringify(await image.recover('paid-image', { attach_id: 'owned-image' })) === JSON.stringify({ ...report, mutated: false }))
      const revokedUpload = await unowned.send('upload-revoked', { image_url: 'https://example.invalid/admitted.png' })
      assert.ok(revokedUpload.kind === 'completed' && !revokedUpload.successful)
      assert.match(JSON.stringify(revokedUpload.value), /当前运行无权进行相似图搜索/u)
      assert.equal(requests.length, 5)
      await pool.query("UPDATE agent_run_dispatch SET state='selected' WHERE run_id=$1", [foreign.id.runId])
      const uncertain = { attach_id: 'foreign-image', max_results: 7 }
      assert.deepEqual(await unowned.send('paid-image-unknown', uncertain), { kind: 'unknown' })
      assert.deepEqual(await unowned.send('paid-image-unknown', uncertain), { kind: 'unknown' })
      assert.equal(requests.length, 6)
      assert.deepEqual((await pool.query("SELECT user_id,query FROM search_usage WHERE query LIKE '[similar-image]%'")).rows,
        [{ user_id: owner, query: '[similar-image]' }])
    })
  } finally {
    release()
    releaseImage()
    await rm(storageRoot, { recursive: true, force: true })
    await core.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`) } finally { await admin.end() }
  }
})


test('相似图校验读取完整的 JPG 和 PNG，拒绝由同一 PNG 截断的伪图片', async () => {
  const canvas = createCanvas(3, 4)
  const png = canvas.toBuffer('image/png')
  const jpg = canvas.toBuffer('image/jpeg', 80)
  assert.equal(await verifySearchImage(png, scope.signal), null)
  assert.equal(await verifySearchImage(jpg, scope.signal), null)
  assert.equal(await verifySearchImage(png.subarray(0, 29), scope.signal), '图片内容无法解析')
})

test('公网下载流拒绝私有地址，并保留请求前取消', async () => {
  const egress = createPublicAgentEgress(defaultOptions.readSafeEgress, defaultOptions.secretKey)
  // 固定环回 IP 会在公网验证阶段被拒绝，测试不需要启动服务或请求真实网络。
  await assert.rejects(egress.open('http://127.0.0.1/download', scope.signal), { code: 'input_rejected' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(egress.open('https://example.test/download', controller.signal), { name: 'AbortError' })
})
