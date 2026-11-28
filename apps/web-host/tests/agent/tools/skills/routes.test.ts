import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { installHttpErrorHandler } from '../../../../src/http/errors.js'
import { registerUserSkillListRoute } from '../../../../src/modules/skills/routes.js'

test('文件技能管理验证身份、使用可信 owner 和版本，并拒绝旧表接口', async () => {
  const app = Fastify({ logger: false })
  const calls: unknown[][] = []
  registerUserSkillListRoute(app, {
    requireUser: async (request, reply) => {
      if (request.headers.authorization !== 'user') return reply.code(401).send({ detail: '未授权' })
    },
    ownerIdFromRequest: () => 'trusted-owner',
    async list() { return [] },
    async createFileSkill(owner, input, context) { calls.push(['create', owner, input, context]); return { id: 'demo' } },
    async updateFileSkill(owner, id, digest, patch, context) {
      calls.push(['update', owner, id, digest, patch, context])
      if (id === 'missing') throw new CoreError('not_found', '技能不存在')
      return { id, content_digest: digest }
    },
    async deleteFileSkill(owner, id, digest, context) { calls.push(['delete', owner, id, digest, context]); return { id } },
  })
  installHttpErrorHandler(app)
  const headers = { authorization: 'user', 'x-undo-context-id': 'editor' }, digest = 'a'.repeat(64)
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/skills/files', payload: {} })).statusCode, 401)
    assert.deepEqual(calls, [])
    const created = await app.inject({ method: 'POST', url: '/api/v1/skills/files', headers,
      payload: { name: '示例', description_short: '摘要', body: '正文', related_tools: [] } })
    assert.equal(created.statusCode, 201)
    assert.deepEqual(calls[0], ['create', 'trusted-owner', { name: '示例', description_short: '摘要', description_long: null,
      category: 'personal', related_tools: [], body: '正文', enabled: true }, 'editor'])
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/skills/files/demo', headers,
      payload: { expectedDigest: digest, patch: { enabled: false } } })).statusCode, 200)
    assert.deepEqual(calls[1], ['update', 'trusted-owner', 'demo', digest, { enabled: false }, 'editor'])
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/skills/files/demo/delete', headers,
      payload: { expectedDigest: digest } })).statusCode, 200)
    assert.deepEqual(calls[2], ['delete', 'trusted-owner', 'demo', digest, 'editor'])
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/skills/files/missing', headers,
      payload: { expectedDigest: digest, patch: { name: '新名' } } })).statusCode, 404)
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/skills/files/demo', headers,
      payload: { expectedDigest: 'invalid', patch: { name: '新名' } } })).statusCode, 422)
    for (const [method, url] of [['POST', '/api/v1/skills'], ['PATCH', '/api/v1/skills/U1'], ['DELETE', '/api/v1/skills/U1']] as const)
      assert.equal((await app.inject({ method, url, headers, payload: {} })).statusCode, 404)
  } finally { await app.close() }
})
