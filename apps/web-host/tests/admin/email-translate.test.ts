import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createAdminEmailTranslator } from '../../src/modules/admin/email-translate.js'

const adminAuth = {
  registerRoutes() {},
  async verifyAdmin() { return true },
  async requireAdmin(request: { headers: Record<string, unknown> }, reply: { code(value: number): { send(value: unknown): unknown } }) {
    if (request.headers.authorization !== 'synthetic-admin') return reply.code(401).send({ detail: '管理员认证失败' })
  },
}
const draft = {
  subject: '中文主题', title: '中文标题', preheader: '', body: '中文正文',
  sections: [{ heading: '', text: '第一段' }], actions: [{ label: '打开', url: 'https://example.test/path' }],
  template: 'notification', theme: 'light', palette: 'neutral', translations: {},
}

test('管理员邮件翻译先认证，再经 Core Provider transport 返回双语结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-email-translate-'))
  const path = join(directory, 'config.override.json')
  await writeFile(path, JSON.stringify({ ai: { provider: 'openai', model: 'synthetic-model', api_key: 'synthetic-key', base_url: 'https://provider.example/v1' } }), { mode: 0o600 })
  let calls = 0
  const response = (content: string) => ({ status: 200, headers: { 'content-type': 'application/json' },
    body: (async function* () { yield new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })) })(), cancel() {} })
  const translate = createAdminEmailTranslator({}, path, () => ({
    async request(request, signal) {
      signal.throwIfAborted()
      calls++
      const body = request.body as { messages: Array<{ content: string | Array<{ text?: string }> }> }
      const prompt = JSON.stringify(body.messages)
      const locale = prompt.includes('ja-JP') ? 'ja-JP' : 'en-US'
      return response(JSON.stringify({ subject: `${locale} subject`, title: `${locale} title`, preheader: '', body: `${locale} body`, sections: [{ heading: 'ignored', text: `${locale} paragraph` }], actions: [{ label: `${locale} action`, url: 'https://attacker.test/' }] }))
    }, async close() {},
  }))
  const app = createApp({
    appName: '合成应用', isReady: async () => true, adminAuth,
    adminEmailTranslate: { translate },
  } as unknown as Parameters<typeof createApp>[0])
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/admin/email/translate', payload: draft })
    assert.equal(denied.statusCode, 401)
    assert.equal(calls, 0)
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/admin/email/translate', headers: { authorization: 'synthetic-admin' }, payload: { ...draft, body: '' } })
    assert.equal(invalid.statusCode, 422)
    assert.equal(calls, 0)
    const allowed = await app.inject({ method: 'POST', url: '/api/v1/admin/email/translate', headers: { authorization: 'synthetic-admin' }, payload: draft })
    assert.equal(allowed.statusCode, 200)
    assert.deepEqual(Object.keys(allowed.json().translations), ['ja-JP', 'en-US'])
    assert.equal(calls, 2)
    assert.equal(allowed.json().translations['ja-JP'].actions[0].url, 'https://example.test/path')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('模型调用失败映射为 Python 兼容的 502 通用错误且不泄露异常', async () => {
  const app = createApp({ appName: '合成应用', isReady: async () => true, adminAuth,
    adminEmailTranslate: { async translate() { throw new Error('synthetic-secret and upstream body') } },
  } as unknown as Parameters<typeof createApp>[0])
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/email/translate', headers: { authorization: 'synthetic-admin' }, payload: draft })
    assert.equal(response.statusCode, 502)
    assert.deepEqual(response.json(), { detail: '多语言邮件生成失败，请检查当前模型配置' })
    assert.equal(response.body.includes('synthetic-secret'), false)
    assert.equal(response.body.includes('upstream body'), false)
  } finally { await app.close() }
})
