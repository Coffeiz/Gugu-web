import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const apps: Array<{ close(): Promise<void> }> = []

function testApp(options: Parameters<typeof createApp>[0]) {
  const app = createApp(options)
  apps.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

test('GET /health preserves the existing Web health response', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({ method: 'GET', url: '/health' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok', app: '合成测试应用' })
})

test('POST /api/v1/auth/register reports unavailable instead of an unregistered 404', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username: 'sample', email: 'sample@example.invalid', password: 'secret' },
  })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { detail: '注册服务暂不可用，请稍后重试' })
})

test('POST /api/v1/auth/register uses the configured registration operation and issues a session', async () => {
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    registration: {
      secret: 'synthetic-secret',
      verificationRequired: false,
      async rateLimit() {},
      async userExists() { return false },
      async verifyRegistrationCode() { return false },
      async registerUser(input) {
        assert.equal(input.email, 'sample@example.invalid')
        assert.match(input.hashedPassword, /^\$2[aby]\$/)
        return {
          id: '00000000-0000-4000-8000-000000000001',
          username: input.username,
          displayName: input.displayName,
          email: input.email,
          isActive: true,
          securityVersion: 1,
          avatarUrl: null,
          createdAt: '2026-11-13T00:00:00.000Z',
          timezone: null,
          emailSubscribed: input.emailSubscribed,
          imChannels: [],
        }
      },
      async seedUser() {},
      now: () => 1_800_000_000_000,
    },
  })

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username: 'sample', email: 'Sample@Example.Invalid', password: 'synthetic-password' },
  })

  assert.equal(response.statusCode, 201)
  assert.equal(response.json().user.email, 'sample@example.invalid')
  const cookies = response.headers['set-cookie']
  assert.ok(Array.isArray(cookies))
  assert.ok(cookies.some((cookie) => cookie.startsWith('gugu_user_access_token=')))
})

test('file browsing is mounted behind user auth and receives the owner from Host context', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-file-browser-host-secret'
  const calls: string[] = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id,
          username: 'sample',
          displayName: '示例用户',
          email: 'sample@example.invalid',
          avatarUrl: null,
          createdAt: null,
          timezone: null,
          emailSubscribed: false,
          imChannels: [],
          isActive: true,
          securityVersion: 1,
        } : null
      },
    },
    fileBrowser: {
      async listFiles(ownerId) { calls.push(ownerId); return { items: [] } },
      async listFolders(ownerId) { calls.push(ownerId); return { items: [] } },
    },
  })
  const token = createUserToken(userId, 1, secret)

  const denied = await app.inject({ url: '/api/v1/files?space=personal' })
  const allowed = await app.inject({
    url: '/api/v1/files?space=personal',
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 200)
  assert.deepEqual(calls, [userId])
})

test('Local 文件上传先经过用户认证，并只把 Host owner 交给存储操作', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-file-upload-host-secret'
  const calls: string[] = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    fileUploads: {
      async getUploadCapacity(ownerId) { calls.push(`capacity:${ownerId}`); return 32 },
      async store(ownerId, upload) {
        calls.push(`store:${ownerId}:${upload.input.space}:${upload.sizeBytes}`)
        return { id: 7, displayName: upload.originalName }
      },
    },
  })
  const token = createUserToken(userId, 1, secret)
  const boundary = 'gugu-host-upload-boundary'
  const payload = [
    `--${boundary}\r\nContent-Disposition: form-data; name="space"\r\n\r\npersonal\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="memo.txt"\r\nContent-Type: text/plain\r\n\r\nbody\r\n`,
    `--${boundary}--\r\n`,
  ].join('')
  const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }

  const denied = await app.inject({ method: 'POST', url: '/api/v1/files', headers, payload })
  const allowed = await app.inject({
    method: 'POST', url: '/api/v1/files', headers: { ...headers, authorization: `Bearer ${token}` }, payload,
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 201)
  assert.deepEqual(allowed.json(), { id: 7, displayName: 'memo.txt' })
  assert.deepEqual(calls, [`capacity:${userId}`, `store:${userId}:personal:4`])
})

test('文件删除先认证并只向适配器传递 Host owner', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-file-delete-host-secret'
  const calls: unknown[][] = []
  const app = testApp({
    appName: '合成测试应用', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    fileDeletes: { async remove(...args) { calls.push(args) } },
  })
  const token = createUserToken(userId, 1, secret)
  const denied = await app.inject({ method: 'DELETE', url: '/api/v1/files/8' })
  const allowed = await app.inject({
    method: 'DELETE', url: '/api/v1/files/8',
    headers: { authorization: `Bearer ${token}`, 'x-undo-context-id': 'undo-context' },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 204)
  assert.deepEqual(calls, [[userId, 8, 'undo-context', null]])
})

test('文件正文更新先认证并只向适配器传递 Host owner', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-file-content-host-secret'
  const calls: unknown[][] = []
  const app = testApp({
    appName: '合成测试应用', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    fileContents: {
      async update(...args) { calls.push(args); return { id: 9, version: 2 } },
    },
  })
  const token = createUserToken(userId, 1, secret)
  const payload = { content: '更新后的正文', version: 1 }
  const denied = await app.inject({ method: 'PUT', url: '/api/v1/files/9/content', payload })
  const allowed = await app.inject({
    method: 'PUT', url: '/api/v1/files/9/content',
    headers: { authorization: `Bearer ${token}`, 'x-undo-context-id': 'editor-tab' },
    payload,
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 200)
  assert.deepEqual(allowed.json(), { id: 9, version: 2 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]![0], userId)
  assert.equal(calls[0]![1], 9)
  assert.equal(calls[0]![2], payload.content)
  assert.equal(calls[0]![3], payload.version)
  assert.equal((calls[0]![4] as { undoContextId: string }).undoContextId, 'editor-tab')
})

test('文件恢复先认证并只向适配器传递 Host owner', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-file-restore-host-secret'
  const calls: unknown[][] = []
  const app = testApp({
    appName: '合成测试应用', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    fileRestores: { async restore(...args) { calls.push(args) } },
  })
  const token = createUserToken(userId, 1, secret)
  const denied = await app.inject({ method: 'POST', url: '/api/v1/trash/8/restore' })
  const allowed = await app.inject({
    method: 'POST', url: '/api/v1/trash/8/restore',
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 204)
  assert.deepEqual(calls, [[userId, 8]])
})

test('POST /api/v1/auth/registration-code reports unavailable instead of an unregistered 404', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration-code',
    payload: { email: 'sample@example.invalid' },
  })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { detail: '邮箱验证码注册当前不可用' })
})

test('GET /health/ready reports an unavailable data runtime without claiming readiness', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => false })

  const response = await app.inject({ method: 'GET', url: '/health/ready' })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { status: 'not_ready' })
})

test('GET /health/ready reports readiness only after the data runtime is available', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({ method: 'GET', url: '/health/ready' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok' })
})

test('GET /health/ready hides readiness dependency errors from HTTP clients', async () => {
  let reportedFailure = false
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => {
      throw new Error('synthetic database credential detail')
    },
    onReadinessError: () => {
      reportedFailure = true
    },
  })

  const response = await app.inject({ method: 'GET', url: '/health/ready' })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { status: 'not_ready' })
  assert.equal(response.body.includes('synthetic database credential detail'), false)
  assert.equal(reportedFailure, true)
})

test('Admin user list is registered with the Host Admin guard and query dependency', async () => {
  const calls: string[] = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'test-admin')
          return reply.code(401).send({ detail: '管理员认证失败' })
      },
    },
    adminUsers: {
      async query(sql) {
        calls.push(sql)
        return []
      },
    },
  })

  const denied = await app.inject({ method: 'GET', url: '/api/v1/admin/users' })
  assert.equal(denied.statusCode, 401)
  assert.equal(calls.length, 0)

  const allowed = await app.inject({
    method: 'GET', url: '/api/v1/admin/users', headers: { authorization: 'test-admin' },
  })
  assert.equal(allowed.statusCode, 200)
  assert.deepEqual(allowed.json(), { items: [], total: 0 })
  assert.equal(calls.length, 5)
})

test('project PATCH is mounted behind user authentication', async () => {
  const calls: unknown[][] = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: { secret: 'test-secret', async lookupUser() { return null } },
    updateProject: async (...args) => {
      calls.push(args)
      return { id: 17 }
    },
  })

  const response = await app.inject({
    method: 'PATCH', url: '/api/v1/projects/17', payload: { version: 1, name: '项目' },
  })

  assert.equal(response.statusCode, 401)
  assert.equal(calls.length, 0)
})

test('Agent 会话列表只接受 Host 认证上下文中的 owner', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-agent-session-secret'
  const owners: string[] = []
  const messageLookups: Array<{ ownerId: string; messageId: number }> = []
  const detailLookups: Array<{ ownerId: string; sessionId: number; messageId: number; timelineIndex: number }> = []
  let stateLabelReads = 0
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id,
          username: 'sample',
          displayName: '示例用户',
          email: 'sample@example.invalid',
          avatarUrl: null,
          createdAt: null,
          timezone: null,
          emailSubscribed: false,
          imChannels: [],
          isActive: true,
          securityVersion: 1,
        } : null
      },
    },
    async listAgentSessions(ownerId) {
      owners.push(ownerId)
      return [{ id: 9, title: '合成会话' }]
    },
    async locateAgentMessage(ownerId, messageId) {
      messageLookups.push({ ownerId, messageId })
      return { id: messageId, sessionId: 9 }
    },
    async readAgentToolEventDetails(ownerId, sessionId, messageId, timelineIndex) {
      detailLookups.push({ ownerId, sessionId, messageId, timelineIndex })
      return { toolInput: { query: '合成查询' }, toolResult: '完成' }
    },
    agentMisc: {
      commandMenu: () => [{ command: '/help', insert: '/help' }],
      defaultStateLabels: { _thinking: '默认思考文案', _context_compaction: '默认整理文案' },
      stateLabelOverrides: () => {
        stateLabelReads++
        return { _thinking: '覆盖思考文案', web_search: '不得覆盖普通标签' }
      },
    },
  })
  const token = createUserToken(userId, 1, secret)

  const denied = await app.inject({ url: '/api/v1/agent/sessions' })
  const deniedMessage = await app.inject({ url: '/api/v1/agent/messages/23' })
  const deniedDetails = await app.inject({
    url: '/api/v1/agent/sessions/9/tool-event-details?source=timeline&message_id=23&timeline_index=1',
  })
  const deniedCommands = await app.inject({ url: '/api/v1/agent/commands' })
  const deniedLabels = await app.inject({ url: '/api/v1/agent/ui-labels' })
  const allowed = await app.inject({
    url: '/api/v1/agent/sessions?ownerId=00000000-0000-4000-8000-000000000099',
    headers: { authorization: `Bearer ${token}`, 'x-user-id': '00000000-0000-4000-8000-000000000099' },
  })
  const allowedMessage = await app.inject({
    url: '/api/v1/agent/messages/23',
    headers: { authorization: `Bearer ${token}`, 'x-user-id': '00000000-0000-4000-8000-000000000099' },
  })
  const allowedDetails = await app.inject({
    url: '/api/v1/agent/sessions/9/tool-event-details?source=timeline&message_id=23&timeline_index=1',
    headers: { authorization: `Bearer ${token}`, 'x-user-id': '00000000-0000-4000-8000-000000000099' },
  })
  const allowedCommands = await app.inject({
    url: '/api/v1/agent/commands',
    headers: { authorization: `Bearer ${token}` },
  })
  const allowedLabels = await app.inject({
    url: '/api/v1/agent/ui-labels',
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(deniedMessage.statusCode, 401)
  assert.equal(deniedDetails.statusCode, 401)
  assert.equal(deniedCommands.statusCode, 401)
  assert.equal(deniedLabels.statusCode, 401)
  assert.equal(allowed.statusCode, 200)
  assert.equal(allowedMessage.statusCode, 200)
  assert.equal(allowedDetails.statusCode, 200)
  assert.deepEqual(allowedDetails.json(), { toolInput: { query: '合成查询' }, toolResult: '完成' })
  assert.deepEqual(allowedCommands.json(), { commands: [{ command: '/help', insert: '/help' }] })
  assert.deepEqual(allowedLabels.json(), {
    thinking: ['覆盖思考文案'],
    contextCompacting: ['默认整理文案'],
  })
  assert.deepEqual(allowedMessage.json(), { id: 23, sessionId: 9 })
  assert.deepEqual(allowed.json(), [{ id: 9, title: '合成会话' }])
  assert.deepEqual(owners, [userId])
  assert.deepEqual(messageLookups, [{ ownerId: userId, messageId: 23 }])
  assert.deepEqual(detailLookups, [{ ownerId: userId, sessionId: 9, messageId: 23, timelineIndex: 1 }])
  assert.equal(stateLabelReads, 1)
})

test('Agent 会话重命名接入认证 Host 并使用可信 owner', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-agent-session-rename-secret'
  const calls: Array<{ ownerId: string; sessionId: number; title: string }> = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    async renameAgentSession(ownerId, sessionId, title) {
      calls.push({ ownerId, sessionId, title })
      return { id: sessionId, title, title_locked: true }
    },
  })
  const token = createUserToken(userId, 1, secret)

  const denied = await app.inject({
    method: 'PATCH', url: '/api/v1/agent/sessions/17', payload: { title: '新标题' },
  })
  const allowed = await app.inject({
    method: 'PATCH', url: '/api/v1/agent/sessions/17?ownerId=00000000-0000-4000-8000-000000000099',
    headers: { authorization: `Bearer ${token}`, 'x-user-id': '00000000-0000-4000-8000-000000000099' },
    payload: { title: '  用户标题  ' },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 200)
  assert.deepEqual(allowed.json(), { id: 17, title: '用户标题', title_locked: true })
  assert.deepEqual(calls, [{ ownerId: userId, sessionId: 17, title: '用户标题' }])
})

test('global and per-user Admin security events use the Host guard and injected query adapters', async () => {
  const queries: string[] = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'test-admin')
          return reply.code(401).send({ detail: '管理员认证失败' })
      },
    },
    adminSecurityEvents: {
      fingerprintUserId: (id) => `fingerprint:${id}`,
      async query(sql) { queries.push(sql); return [] },
    },
    adminUserSecurityEvents: {
      async query(sql) {
        queries.push(sql)
        return sql.includes('FROM users') ? [{ id: '00000000-0000-4000-8000-000000000001' }] : []
      },
    },
  })

  const deniedGlobal = await app.inject({ url: '/api/v1/admin/audit-log/security-events' })
  const deniedUser = await app.inject({ url: '/api/v1/admin/users/00000000-0000-4000-8000-000000000001/security-events' })
  assert.equal(deniedGlobal.statusCode, 401)
  assert.equal(deniedUser.statusCode, 401)
  assert.equal(queries.length, 0)

  const headers = { authorization: 'test-admin' }
  const global = await app.inject({ url: '/api/v1/admin/audit-log/security-events', headers })
  const user = await app.inject({ url: '/api/v1/admin/users/00000000-0000-4000-8000-000000000001/security-events', headers })
  assert.equal(global.statusCode, 200)
  assert.equal(user.statusCode, 200)
  assert.equal(queries.length, 3)
  const invalidGlobal = await app.inject({
    url: '/api/v1/admin/audit-log/security-events?limit=0', headers,
  })
  const invalidUser = await app.inject({
    url: '/api/v1/admin/users/00000000-0000-4000-8000-000000000001/security-events?limit=0', headers,
  })
  assert.equal(invalidGlobal.statusCode, 422)
  assert.equal(invalidUser.statusCode, 422)
  assert.equal(queries.length, 3)
  await app.close()
})

test('agent message history is owner-scoped behind Host auth and validates pagination parameters', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-agent-history-host-secret'
  const calls: Array<{ ownerId: string; sessionId: number; options: unknown }> = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id,
          username: 'sample',
          displayName: '示例用户',
          email: 'sample@example.invalid',
          avatarUrl: null,
          createdAt: null,
          timezone: null,
          emailSubscribed: false,
          imChannels: [],
          isActive: true,
          securityVersion: 1,
        } : null
      },
    },
    listAgentMessages: async (ownerId, sessionId, options) => {
      calls.push({ ownerId, sessionId, options })
      return { session: { id: sessionId }, messages: [], interactions: [] }
    },
  })
  const token = createUserToken(userId, 1, secret)

  const denied = await app.inject({ url: '/api/v1/agent/sessions/23/messages' })
  const allowed = await app.inject({
    url: '/api/v1/agent/sessions/23/messages?limit=500&before_id=17&restore_interactions=true',
    headers: { authorization: `Bearer ${token}` },
  })
  const invalid = await app.inject({
    url: '/api/v1/agent/sessions/not-a-number/messages',
    headers: { authorization: `Bearer ${token}` },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 200)
  assert.deepEqual(allowed.json(), { session: { id: 23 }, messages: [], interactions: [] })
  assert.deepEqual(calls, [{
    ownerId: userId,
    sessionId: 23,
    options: { limit: 200, beforeId: 17, restoreInteractions: true },
  }])
  assert.equal(invalid.statusCode, 422)
})

test('sensitive interaction deep link is mounted behind Host auth and resolves only for the authenticated owner', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-interaction-session-host-secret'
  const calls: Array<[string, number]> = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id,
          username: 'sample',
          displayName: '示例用户',
          email: 'sample@example.invalid',
          avatarUrl: null,
          createdAt: null,
          timezone: null,
          emailSubscribed: false,
          imChannels: [],
          isActive: true,
          securityVersion: 1,
        } : null
      },
    },
    lookupAgentInteractionSession: async (ownerId, promptId) => {
      calls.push([ownerId, promptId])
      return { session_id: 42 }
    },
  })
  const token = createUserToken(userId, 1, secret)

  const denied = await app.inject({ method: 'GET', url: '/api/v1/agent/interactions/8/session' })
  const allowed = await app.inject({
    method: 'GET',
    url: '/api/v1/agent/interactions/8/session?owner_id=attacker',
    headers: { authorization: `Bearer ${token}`, 'x-user-id': 'attacker' },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 200)
  assert.deepEqual(allowed.json(), { session_id: 42 })
  assert.deepEqual(calls, [[userId, 8]])
})

test('Agent refresh-context route is Host-authenticated and advances only the authenticated owner session', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-agent-refresh-host-secret'
  const calls: Array<[string, number]> = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id,
          username: 'sample',
          displayName: '示例用户',
          email: 'sample@example.invalid',
          avatarUrl: null,
          createdAt: null,
          timezone: null,
          emailSubscribed: false,
          imChannels: [],
          isActive: true,
          securityVersion: 1,
        } : null
      },
    },
    async refreshAgentSession(ownerId, sessionId) {
      calls.push([ownerId, sessionId])
      return { id: sessionId, context_epoch: 4 }
    },
  })
  const token = createUserToken(userId, 1, secret)

  const denied = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions/7/refresh-context' })
  const allowed = await app.inject({
    method: 'POST',
    url: '/api/v1/agent/sessions/7/refresh-context?owner_id=attacker',
    headers: { authorization: `Bearer ${token}`, 'x-user-id': 'attacker' },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 200)
  assert.deepEqual(allowed.json(), { id: 7, context_epoch: 4, refresh_scheduled: true })
  assert.deepEqual(calls, [[userId, 7]])
})

test('Agent pending queue routes use Host owner, protect claim tokens, and publish only successful writes', async () => {
  const userId = '00000000-0000-4000-8000-000000000001'
  const secret = 'synthetic-agent-pending-queue-host-secret'
  const calls: unknown[][] = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === userId ? {
          id,
          username: 'sample',
          displayName: '示例用户',
          email: 'sample@example.invalid',
          avatarUrl: null,
          createdAt: null,
          timezone: null,
          emailSubscribed: false,
          imChannels: [],
          isActive: true,
          securityVersion: 1,
        } : null
      },
    },
    agentPendingQueueReads: {
      nowSeconds: () => 100,
      async readQueue(...args) {
        calls.push(['read', ...args])
        return { sessionId: 7, items: [{ key: 1, text: '合成消息', _claim_token: 'hidden', _claim_until: 110 }] }
      },
      async readImportedDrafts(ownerId) {
        calls.push(['drafts', ownerId])
        return [{ queueId: 'import-one', items: [{ key: 2, text: '合成草稿' }] }]
      },
    },
    agentPendingQueuePatch: {
      async patch(...args) { calls.push(['patch', ...args]) },
      async publishChanged(...args) { calls.push(['publish', ...args]) },
    },
    agentPendingQueueReplace: {
      async replaceDraft(...args) { calls.push(['replace', ...args]) },
    },
    agentPendingQueueClaims: {
      async claim(...args) { calls.push(['claim', ...args]); return { claimToken: 'claim-token' } },
      async release(...args) { calls.push(['release', ...args]); return true },
      async publishChanged(...args) { calls.push(['publish', ...args]) },
    },
  })
  const token = createUserToken(userId, 1, secret)
  const headers = { authorization: `Bearer ${token}`, 'x-user-id': 'attacker', 'x-client-id': 'client-synthetic' }

  const denied = await app.inject({ url: '/api/v1/agent/pending-queues/session-7' })
  const queue = await app.inject({ url: '/api/v1/agent/pending-queues/session-7?owner_id=attacker', headers })
  const drafts = await app.inject({ url: '/api/v1/agent/pending-queues/imported-drafts?owner_id=attacker', headers })
  const patchResponse = await app.inject({
    method: 'PATCH', url: '/api/v1/agent/pending-queues/session-7', headers,
    payload: { session_id: 7, items: [{ key: 3, text: '更新' }] },
  })
  const replaceResponse = await app.inject({
    method: 'PUT', url: '/api/v1/agent/pending-queues/import-one', headers,
    payload: { items: [{ key: 8, text: '替换草稿' }] },
  })
  const claim = await app.inject({
    method: 'POST', url: '/api/v1/agent/pending-queues/session-7/items/3/claim', headers,
    payload: { session_id: 7 },
  })
  const release = await app.inject({
    method: 'POST', url: '/api/v1/agent/pending-queues/session-7/items/3/release', headers,
    payload: { session_id: 7, claim_token: 'claim-token' },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(queue.statusCode, 200)
  assert.deepEqual(queue.json(), {
    sessionId: 7,
    items: [{ key: 1, text: '合成消息', queue_id: 'session-7', session_id: 7, claimed: true }],
  })
  assert.doesNotMatch(queue.body, /hidden/)
  assert.equal(drafts.statusCode, 200)
  assert.deepEqual(drafts.json(), { queues: [{ queue_id: 'import-one', items: [{ key: 2, text: '合成草稿', queue_id: 'import-one', session_id: null, claimed: false }] }] })
  assert.equal(patchResponse.statusCode, 200)
  assert.equal(replaceResponse.statusCode, 200)
  assert.deepEqual(replaceResponse.json(), { ok: true, count: 1 })
  assert.equal(claim.statusCode, 200)
  assert.deepEqual(claim.json(), { claim_token: 'claim-token' })
  assert.equal(release.statusCode, 200)
  assert.deepEqual(release.json(), { released: true })
  assert.deepEqual(calls, [
    ['read', userId, 'session-7'],
    ['drafts', userId],
    ['patch', userId, 'session-7', 7, [{ key: 3, text: '更新', attachments: [], references: [] }], []],
    ['publish', userId, 7, 'client-synthetic'],
    ['replace', userId, 'import-one', [{ key: 8, text: '替换草稿', attachments: [], references: [] }]],
    ['claim', userId, 7, 'session-7', 3],
    ['release', userId, 7, 'session-7', 3, 'claim-token'],
    ['publish', userId, 7, 'client-synthetic'],
  ])
})
