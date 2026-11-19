import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { createApp } from '../../src/app.js'
import { registerAgentCapabilityCatalogRoute } from '../../src/modules/admin/llm.js'
import { createCapabilityCatalog } from '@gugu/core/agent/capabilities'
import { createBuiltinSkillDefinitions } from '@gugu/core/skills'
import { createBundledSkillDocuments } from '@gugu/core/skills/bundled'

test('Admin 能力目录要求管理员认证并只返回共享 Core 投影', async () => {
  const app = Fastify()
  registerAgentCapabilityCatalogRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send()
    },
    read: async () => createCapabilityCatalog({ tools: [{ name: 'list_projects', description: '查询项目。内部参数 schema。', category: 'projects', enabled: true }], skills: [] }),
  })
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/agent/capabilities' })).statusCode, 401)
    const response = await app.inject({ url: '/api/v1/admin/agent/capabilities', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      generation: 1, diagnostics: [], skills: [],
      tools: [{ name: 'list_projects', description_short: '查询项目。', category: 'projects', permissions: [], platforms: [], related_skills: [], source: 'builtin', enabled: true }],
    })
    assert.doesNotMatch(response.body, /schema/)
  } finally { await app.close() }
})

test('createApp 生产组合根先执行 Admin guard 再读取 Core 能力目录', async () => {
  let authorized = false
  let reads = 0
  const app = createApp({
    appName: 'test',
    isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async requireAdmin(_request, reply) {
        if (!authorized) return reply.code(401).send()
      },
      async verifyAdmin() { return authorized },
    },
    adminAgentCapabilities: { async read() {
      reads += 1
      return createCapabilityCatalog({ tools: [{ name: 'list_projects', description: '列出项目。', category: '项目' }], skills: [] })
    } },
  })
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/agent/capabilities' })).statusCode, 401)
    assert.equal(reads, 0)
    authorized = true
    const response = await app.inject({ url: '/api/v1/admin/agent/capabilities' })
    assert.equal(response.statusCode, 200)
    assert.equal(reads, 1)
    assert.deepEqual(response.json().tools.map((item: { name: string }) => item.name), ['list_projects'])
  } finally { await app.close() }
})

test('Core 构建制品只装载 manifest 白名单内的内置 Skill 元数据', async () => {
  const skills = await createBuiltinSkillDefinitions(createBundledSkillDocuments(), new AbortController().signal)
  const catalog = createCapabilityCatalog({ tools: [], skills })
  assert.equal(catalog.skills.length, 10)
  assert.ok(catalog.skills.every(item => item.source === 'builtin' && item.description_short.length > 0))
  assert.doesNotMatch(JSON.stringify(catalog), /body|联网搜索技能正文/)
})
