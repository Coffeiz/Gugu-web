import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { registerUserSkillWriteRoutes } from '../../src/modules/skills/routes.js'

const skillRow = (id: string, name: string, related_tools: readonly string[] = []) => ({
  id, name, description_short: '摘要', description_long: null, category: 'personal', related_tools: [...related_tools],
  body: '正文', source: 'user', managed_by: 'user', enabled: true, content_digest: 'digest',
  created_at: null, updated_at: null,
})

test('Skill 创建与更新经过认证 owner，保留 Python 的状态码和 DTO', async () => {
  const app = Fastify({ logger: false })
  const calls: unknown[][] = []
  registerUserSkillWriteRoutes(app, {
    requireUser: async (request, reply) => {
      if (request.headers.authorization !== 'user') return reply.code(401).send({ detail: '未授权' })
    },
    ownerIdFromRequest: () => 'trusted-owner',
    manager: {
      create: async (owner, input) => {
        calls.push(['create', owner, input])
        return skillRow('U1', input.name.trim(), input.related_tools)
      },
      update: async (owner, id, patch) => {
        calls.push(['update', owner, id, patch])
        if (id === 'missing') throw new CoreError('not_found', 'Skill 不存在')
        return { ...skillRow(id, patch.name ?? '原名称'), description_short: patch.description_short?.trim() ?? '摘要', enabled: patch.enabled ?? true }
      },
    },
  })
  installHttpErrorHandler(app)
  try {
    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/skills', payload: { name: '合成' } })
    assert.equal(unauthorized.statusCode, 401)
    assert.deepEqual(calls, [])

    const created = await app.inject({
      method: 'POST', url: '/api/v1/skills', headers: { authorization: 'user' },
      payload: { name: '  合成技能 ', description_short: ' 摘要 ', body: ' 正文 ', related_tools: [], user_id: 'attacker' },
    })
    assert.equal(created.statusCode, 201)
    assert.deepEqual(created.json(), skillRow('U1', '合成技能'))
    assert.deepEqual(calls[0], ['create', 'trusted-owner', {
      name: '  合成技能 ', description_short: ' 摘要 ', description_long: null,
      category: 'personal', related_tools: [], body: ' 正文 ', enabled: true, managed_by: 'user',
    }])

    const updated = await app.inject({
      method: 'PATCH', url: '/api/v1/skills/U1', headers: { authorization: 'user' },
      payload: { description_short: ' 新摘要 ', enabled: false, user_id: 'attacker' },
    })
    assert.equal(updated.statusCode, 200)
    assert.deepEqual(updated.json(), { ...skillRow('U1', '原名称'), description_short: '新摘要', enabled: false })
    assert.deepEqual(calls[1], ['update', 'trusted-owner', 'U1', { description_short: ' 新摘要 ', enabled: false, managed_by: 'user' }])

    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/skills', headers: { authorization: 'user' },
      payload: { name: '', description_short: '摘要', body: '正文' },
    })
    assert.equal(invalid.statusCode, 422)

    const missing = await app.inject({
      method: 'PATCH', url: '/api/v1/skills/missing', headers: { authorization: 'user' }, payload: { name: '新名' },
    })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: 'Skill 不存在' })
  } finally {
    await app.close()
  }
})
