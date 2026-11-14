import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { registerPreferencesRoutes, type PreferencesStore } from '../../src/domains/preferences/preferences.js'
import type { PreferenceTextFiles, PreferenceTextKind } from '../../src/domains/preferences/persistence/personality-files.js'
import { installFileUploadSupport } from '../../src/domains/files/file-upload.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

const trustedOwner = '00000000-0000-4000-8000-000000000021'

function requireAuthenticated() {
  return async (request: { headers: Record<string, unknown> }) => {
    if (request.headers.authorization !== 'Bearer valid') {
      throw Object.assign(new Error('未认证'), { statusCode: 401 })
    }
  }
}

function makeApp(
  store: PreferencesStore,
  calls: { ownerReads: string[]; ownerWrites: string[] } = { ownerReads: [], ownerWrites: [] },
  runtime: {
    textFiles?: PreferenceTextFiles
    personalityPreferenceAvailable?: boolean
    invalidated?: string[]
    bumped?: string[]
  } = {},
) {
  const app = Fastify()
  installHttpErrorHandler(app)
  installFileUploadSupport(app)
  registerPreferencesRoutes(app, {
    requireUser: requireAuthenticated(),
    ownerIdFromRequest: () => trustedOwner,
    userEmailFromRequest: () => 'preferences-user@example.test',
    textFiles: runtime.textFiles,
    personalityPreferenceAvailable: runtime.personalityPreferenceAvailable,
    ...(runtime.invalidated ? { async invalidatePersonalitySnapshots(ownerId: string) { runtime.invalidated?.push(ownerId) } } : {}),
    ...(runtime.bumped ? { async bumpPreferencesContextRevision(ownerId: string) { runtime.bumped?.push(ownerId) } } : {}),
    store: {
      ...store,
      async read(ownerId) {
        calls.ownerReads.push(ownerId)
        return store.read(ownerId)
      },
      async write(ownerId, data) {
        calls.ownerWrites.push(ownerId)
        return store.write(ownerId, data)
      },
    },
  })
  return app
}

test('GET requires authentication and returns Python defaults with unsupported personality fields explicitly unavailable', async () => {
  const owners: string[] = []
  const app = makeApp({
    async read(ownerId) { owners.push(ownerId); return null },
    async write() {},
  })
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/preferences' })
    assert.equal(unauthorized.statusCode, 401)
    assert.deepEqual(owners, [])

    const response = await app.inject({
      method: 'GET', url: '/api/v1/preferences', headers: { authorization: 'Bearer valid', 'x-owner-id': 'attacker' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(owners, [trustedOwner])
    const body = response.json()
    assert.equal(body.locale, null)
    assert.equal(body.theme, 'light')
    assert.equal(body.themeFamily, 'glass')
    assert.equal(body.palette, 'neutral')
    assert.deepEqual(body.lastStages, [])
    assert.deepEqual(body.stageTemplates, [])
    assert.equal(body.shellEnabled, true)
    assert.equal(body.shellDangerousEnabled, true)
    assert.equal(body.automaticModeEnabled, false)
    assert.equal(body.imToolDisplayMode, 'all')
    assert.equal(body.toolInjectionMode, 'description')
    assert.equal(body.customReplyStyle, null)
    assert.equal(body.customReplyStyleEnabled, false)
    assert.equal(body.personalityPreference, null)
    assert.equal(body.personalityPreferenceAvailable, false)
    assert.equal(body.emailChangeEnabled, false)
  } finally {
    await app.close()
  }
})

test('GET normalizes persisted snake_case preferences and Python legacy values to camelCase response', async () => {
  const app = makeApp({
    async read() {
      return {
        locale: 'ja-JP', theme: 'dark', theme_family: 'mono', palette: 'mist',
        last_stages: ['进行中'], stage_templates: [{ name: '默认阶段' }],
        pm_stages_expanded: [], calendar_week_start: 'sunday', default_view: 'files',
        shell_enabled: {}, shell_system_enabled: true, shell_dangerous_enabled: true,
        automatic_mode_enabled: true, decision_guard_enabled: true,
        im_tool_display_mode: 'slow_only', show_intermediate_replies: true,
      personality_preference_updated_at: '2026-11-10T03:00:00+08:00',
        tool_injection_mode: 'compact_schema', preserve_this_key: 'untouched',
      }
    },
    async write() {},
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/preferences', headers: { authorization: 'Bearer valid' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      locale: 'ja-JP', theme: 'dark', themeFamily: 'mono', palette: 'blue',
      lastStages: ['进行中'], stageTemplates: [{ name: '默认阶段' }],
      customReplyStyle: null, customReplyStyleEnabled: false,
      pmStagesExpanded: false, calendarWeekStart: 'sunday', defaultView: 'files',
      shellEnabled: false, shellSystemEnabled: true, shellDangerousEnabled: true,
      automaticModeEnabled: true, decisionGuardEnabled: true,
      imToolDisplayMode: 'slow_only', showIntermediateReplies: true,
      toolInjectionMode: 'full', personalityPreference: null,
      personalityPreferenceEnabled: false, groupPersonalityPreference: null,
      groupPersonalityPreferenceEnabled: false, personalityPreferenceRevision: 0,
      personalityPreferenceUpdatedAt: '2026-11-10T03:00:00+08:00', personalityPreferenceAvailable: false,
      emailChangeEnabled: false,
    })
  } finally {
    await app.close()
  }
})

test('GET migrates the legacy reply-style JSON value into the hidden text file before removing the old key', async () => {
  let stored: Record<string, unknown> = { custom_reply_style: '  保留旧回复风格  ' }
  const { files, values } = memoryTextFiles()
  const app = makeApp({
    async read() { return stored },
    async write(_ownerId, data) { stored = data },
  }, undefined, { textFiles: files })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/preferences', headers: { authorization: 'Bearer valid' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().customReplyStyle, '保留旧回复风格')
    assert.equal(values.get('reply-style'), '保留旧回复风格')
    assert.equal(Object.hasOwn(stored, 'custom_reply_style'), false)
  } finally { await app.close() }
})

test('PATCH merges only supplied general preferences and preserves unrelated JSON keys under the trusted owner', async () => {
  const initial = {
    locale: 'en-US', theme_family: 'glass', palette: 'mist',
    shell_enabled: false, preserved_key: { nested: true },
  }
  let stored: Record<string, unknown> = initial
  const calls = { ownerReads: [] as string[], ownerWrites: [] as string[] }
  const app = makeApp({
    async read() { return stored },
    async write(_ownerId, data) { stored = data },
  }, calls)
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/preferences',
      headers: { authorization: 'Bearer valid' },
      payload: {
        theme: 'dark', stageTemplates: [{ name: '新模板', stages: [] }],
        automaticModeEnabled: true, userId: 'attacker',
      },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(calls.ownerReads, [trustedOwner])
    assert.deepEqual(calls.ownerWrites, [trustedOwner])
    assert.deepEqual(stored, {
      locale: 'en-US', theme_family: 'glass', palette: 'mist', shell_enabled: false,
      preserved_key: { nested: true }, theme: 'dark',
      stage_templates: [{ name: '新模板', stages: [] }], automatic_mode_enabled: true,
    })
    assert.equal(response.json().locale, 'en-US')
    assert.equal(response.json().theme, 'dark')
    assert.equal(response.json().shellEnabled, false)
  } finally {
    await app.close()
  }
})

test('PATCH matches Python handling for omitted or invalid optional values and removes the retired shell autopilot key', async () => {
  let stored: Record<string, unknown> = {
    theme: 'dark',
    calendar_week_start: 'sunday',
    default_view: 'calendar',
    shell_autopilot_enabled: true,
  }
  const app = makeApp({
    async read() { return stored },
    async write(_ownerId, data) { stored = data },
  })

  try {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/preferences',
      headers: { authorization: 'Bearer valid' },
      payload: {
        theme: null,
        calendarWeekStart: 'invalid',
        defaultView: 'unknown',
        locale: 'en-US',
      },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().theme, 'dark')
    assert.equal(response.json().calendarWeekStart, 'sunday')
    assert.equal(response.json().defaultView, 'calendar')
    assert.equal(response.json().locale, 'en-US')
    assert.equal(Object.hasOwn(stored, 'shell_autopilot_enabled'), false)
  } finally {
    await app.close()
  }
})

test('PATCH rejects personality, SMTP, upload, and invalid general fields before persistence', async () => {
  let reads = 0
  let writes = 0
  const app = makeApp({
    async read() { reads += 1; return {} },
    async write() { writes += 1 },
  })
  try {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ personalityPreference: '正文' }, 403],
      [{ smtp: { host: 'mail.invalid' } }, 422],
      [{ personalityUpload: true }, 422],
      [{ theme: 'sepia' }, 422],
      [{ stageTemplates: ['不是对象'] }, 422],
    ]
    for (const [payload, expectedStatus] of cases) {
      const response = await app.inject({
        method: 'PATCH', url: '/api/v1/preferences',
        headers: { authorization: 'Bearer valid' }, payload,
      })
      assert.equal(response.statusCode, expectedStatus)
    }
    assert.equal(reads, 0)
    assert.equal(writes, 0)
  } finally {
    await app.close()
  }
})

function memoryTextFiles(initial: Partial<Record<PreferenceTextKind, string>> = {}) {
  const values = new Map<PreferenceTextKind, string>(Object.entries(initial) as [PreferenceTextKind, string][])
  const files: PreferenceTextFiles = {
    async read(_ownerId, kind) { return values.get(kind) ?? null },
    async write(_ownerId, kind, value) {
      const before = values.get(kind) ?? null
      if (before === value) return false
      if (value === null) values.delete(kind)
      else values.set(kind, value)
      return true
    },
  }
  return { files, values }
}

test('GET returns hidden preference text and keeps the feature availability separate from stored values', async () => {
  const { files } = memoryTextFiles({ personality: '  人格正文 \n', 'group-personality': '群聊正文', 'reply-style': '回复风格' })
  const app = makeApp({ async read() { return { personality_preference_enabled: true, group_personality_preference_enabled: true } }, async write() {} }, undefined, {
    textFiles: files,
    personalityPreferenceAvailable: true,
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/preferences', headers: { authorization: 'Bearer valid' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().personalityPreference, '人格正文')
    assert.equal(response.json().personalityPreferenceEnabled, true)
    assert.equal(response.json().groupPersonalityPreference, '群聊正文')
    assert.equal(response.json().groupPersonalityPreferenceEnabled, true)
    assert.equal(response.json().customReplyStyle, '回复风格')
    assert.equal(response.json().personalityPreferenceAvailable, true)
  } finally { await app.close() }
})

test('PATCH updates reply style/personality files and invalidates snapshots only when context changes', async () => {
  let stored: Record<string, unknown> = {}
  const { files, values } = memoryTextFiles()
  const invalidated: string[] = []
  const bumped: string[] = []
  const app = makeApp({
    async read() { return stored },
    async write(_ownerId, data) { stored = data },
  }, undefined, { textFiles: files, personalityPreferenceAvailable: true, invalidated, bumped })
  try {
    const headers = { authorization: 'Bearer valid' }
    const first = await app.inject({
      method: 'PATCH', url: '/api/v1/preferences', headers,
      payload: { personalityPreference: '  有帮助的伙伴\n ', personalityPreferenceEnabled: true, customReplyStyleEnabled: true },
    })
    assert.equal(first.statusCode, 200)
    assert.equal(values.get('personality'), '有帮助的伙伴')
    assert.equal(first.json().personalityPreferenceRevision, 1)
    assert.equal(first.json().personalityPreferenceEnabled, true)
    assert.equal(first.json().customReplyStyleEnabled, true)
    assert.deepEqual(invalidated, [trustedOwner])
    assert.deepEqual(bumped, [trustedOwner])

    const same = await app.inject({
      method: 'PATCH', url: '/api/v1/preferences/reply-style', headers,
      payload: { content: '  直接清楚  ' },
    })
    assert.equal(same.statusCode, 200)
    assert.equal(values.get('reply-style'), '直接清楚')
    assert.equal(invalidated.length, 2)

    const unchanged = await app.inject({
      method: 'PATCH', url: '/api/v1/preferences/reply-style', headers,
      payload: { content: '直接清楚' },
    })
    assert.equal(unchanged.statusCode, 200)
    assert.equal(invalidated.length, 2)

    const invalid = await app.inject({
      method: 'PATCH', url: '/api/v1/preferences/reply-style', headers,
      payload: { content: `正文${'x'.repeat(10000)}` },
    })
    assert.equal(invalid.statusCode, 422)
    assert.equal(values.get('reply-style'), '直接清楚')
  } finally { await app.close() }
})

test('PostgreSQL store invalidation ports are used when the Host supplies only the store', async () => {
  let stored: Record<string, unknown> = {}
  const { files } = memoryTextFiles()
  const invalidated: string[] = []
  const bumped: string[] = []
  const store: PreferencesStore = {
    textFiles: files,
    async read() { return stored },
    async write(_ownerId, data) { stored = data },
    async invalidatePersonalitySnapshots(ownerId) { invalidated.push(ownerId) },
    async bumpPreferencesContextRevision(ownerId) { bumped.push(ownerId) },
  }
  const app = makeApp(store)
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/preferences/reply-style',
      headers: { authorization: 'Bearer valid' }, payload: { content: '新的回复风格' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(invalidated, [trustedOwner])
    assert.deepEqual(bumped, [trustedOwner])
  } finally { await app.close() }
})

test('SMTP settings are owner-scoped, never echo the password, and preserve an omitted password', async () => {
  const configs = new Map<string, { settings: {
    host: string; port: number; user: string; fromAddr: string; useSsl: boolean; enabled: boolean
  }; password: string }>()
  const reads: string[] = []
  const writes: Array<{ ownerId: string; password: string | null }> = []
  const app = makeApp({
    async read() { return {} },
    async write() {},
    smtp: {
      async read(ownerId) {
        reads.push(ownerId)
        return configs.get(ownerId)?.settings ?? null
      },
      async write(ownerId, settings, password) {
        writes.push({ ownerId, password })
        const previous = configs.get(ownerId)
        configs.set(ownerId, { settings, password: password ?? previous?.password ?? '' })
      },
      async readPassword(ownerId) { return configs.get(ownerId)?.password ?? '' },
    },
  })
  try {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/preferences/smtp' })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(reads, [])

    const headers = { authorization: 'Bearer valid' }
    const initial = await app.inject({ method: 'GET', url: '/api/v1/preferences/smtp', headers })
    assert.equal(initial.statusCode, 200)
    assert.equal(initial.body, 'null')

    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/smtp', headers,
      payload: {
        host: 'smtp.example.test', port: 587, user: 'mailer@example.test', password: 'synthetic-password',
        fromAddr: 'no-reply@example.test', useSsl: false, enabled: true,
      },
    })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().configured, true)
    assert.equal(Object.hasOwn(saved.json(), 'password'), false)
    assert.deepEqual(writes[0], { ownerId: trustedOwner, password: 'synthetic-password' })

    const updated = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/smtp', headers,
      payload: { host: 'smtp.example.test', fromAddr: 'no-reply@example.test' },
    })
    assert.equal(updated.statusCode, 200)
    assert.equal(configs.get(trustedOwner)?.password, 'synthetic-password')
    assert.deepEqual(writes[1], { ownerId: trustedOwner, password: null })

    const invalid = await app.inject({
      method: 'PUT', url: '/api/v1/preferences/smtp', headers,
      payload: { host: ' ', port: 70000 },
    })
    assert.equal(invalid.statusCode, 422)
    assert.equal(writes.length, 2)
  } finally { await app.close() }
})

test('SMTP test uses the saved password and account email when inputs are omitted and hides transport failures', async () => {
  const calls: Array<{ ownerId: string; password: string; toAddr: string }> = []
  let shouldFail = false
  const store: PreferencesStore = {
    async read() { return {} },
    async write() {},
    smtp: {
      async read() { return null },
      async write() {},
      async readPassword() { return 'synthetic-saved-password' },
    },
  }
  const app = Fastify()
  installHttpErrorHandler(app)
  registerPreferencesRoutes(app, {
    requireUser: requireAuthenticated(),
    ownerIdFromRequest: () => trustedOwner,
    userEmailFromRequest: () => 'preferences-user@example.test',
    store,
    smtpTestEmail: async (input) => {
      calls.push({ ownerId: trustedOwner, password: input.password, toAddr: input.toAddr })
      if (shouldFail) throw new Error('synthetic SMTP failure')
    },
  })
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/preferences/smtp/test' })
    assert.equal(denied.statusCode, 401)

    const sent = await app.inject({
      method: 'POST', url: '/api/v1/preferences/smtp/test',
      headers: { authorization: 'Bearer valid' },
      payload: { host: 'smtp.example.test', user: 'mailer@example.test', fromAddr: 'no-reply@example.test' },
    })
    assert.equal(sent.statusCode, 200)
    assert.deepEqual(sent.json(), { ok: true, message: '测试邮件已发送' })
    assert.deepEqual(calls[0], {
      ownerId: trustedOwner, password: 'synthetic-saved-password', toAddr: 'preferences-user@example.test',
    })
    shouldFail = true
    const failed = await app.inject({
      method: 'POST', url: '/api/v1/preferences/smtp/test',
      headers: { authorization: 'Bearer valid' },
      payload: { host: 'smtp.example.test', password: 'synthetic-override-password', toAddr: 'recipient@example.test' },
    })
    assert.equal(failed.statusCode, 200)
    assert.deepEqual(failed.json(), { ok: false, message: 'SMTP 测试失败，请检查服务器、账号或密码' })
    assert.equal(failed.body.includes('synthetic SMTP failure'), false)
    assert.equal(calls.at(-1)?.password, 'synthetic-override-password')
  } finally { await app.close() }
})

test('SMTP style preview is available without saved SMTP settings and validates theme inputs', async () => {
  const app = makeApp({ async read() { return {} }, async write() {} })
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/preferences/smtp/preview', payload: {} })
    assert.equal(denied.statusCode, 401)

    const preview = await app.inject({
      method: 'POST', url: '/api/v1/preferences/smtp/preview',
      headers: { authorization: 'Bearer valid' },
      payload: { template: 'security', theme: 'dark', palette: 'green' },
    })
    assert.equal(preview.statusCode, 200)
    const html = preview.json().html as string
    assert.match(html, /color-scheme:dark/)
    assert.match(html, /#a9c2b5/)
    assert.match(html, /SECURITY/)
    assert.match(html, /当前模板：security/)
    assert.match(html, /logo-large2\.png/)

    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/preferences/smtp/preview',
      headers: { authorization: 'Bearer valid' }, payload: { theme: 'system' },
    })
    assert.equal(invalid.statusCode, 422)
  } finally { await app.close() }
})

test('upload routes enforce file type, UTF-8, byte limit, and personality availability', async () => {
  let stored: Record<string, unknown> = {}
  const { files, values } = memoryTextFiles()
  const invalidated: string[] = []
  const app = makeApp({
    async read() { return stored },
    async write(_ownerId, data) { stored = data },
  }, undefined, { textFiles: files, personalityPreferenceAvailable: true, invalidated })
  const multipart = (filename: string, content: Buffer | string) => {
    const boundary = 'gugu-preference-upload-test'
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    return { body, contentType: `multipart/form-data; boundary=${boundary}` }
  }
  try {
    const headers = { authorization: 'Bearer valid' }
    const good = multipart('reply.txt', '  句子短一些\n')
    const uploaded = await app.inject({ method: 'POST', url: '/api/v1/preferences/reply-style/upload', headers: { ...headers, 'content-type': good.contentType }, payload: good.body })
    assert.equal(uploaded.statusCode, 200)
    assert.equal(values.get('reply-style'), '句子短一些')

    const badType = multipart('persona.txt', '人格')
    const rejectedType = await app.inject({ method: 'POST', url: '/api/v1/preferences/personality/upload', headers: { ...headers, 'content-type': badType.contentType }, payload: badType.body })
    assert.equal(rejectedType.statusCode, 415)

    const oversized = multipart('reply.md', 'x'.repeat(40001))
    const rejectedSize = await app.inject({ method: 'POST', url: '/api/v1/preferences/reply-style/upload', headers: { ...headers, 'content-type': oversized.contentType }, payload: oversized.body })
    assert.equal(rejectedSize.statusCode, 413)
    assert.equal(values.get('reply-style'), '句子短一些')

    const invalidUtf8 = multipart('reply.md', Buffer.from([0xff, 0xfe]))
    const rejectedEncoding = await app.inject({ method: 'POST', url: '/api/v1/preferences/reply-style/upload', headers: { ...headers, 'content-type': invalidUtf8.contentType }, payload: invalidUtf8.body })
    assert.equal(rejectedEncoding.statusCode, 400)
    assert.equal(invalidated.length, 1)
  } finally { await app.close() }
})
