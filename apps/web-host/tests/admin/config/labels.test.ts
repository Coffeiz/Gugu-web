import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAgentStateLabelRoutes } from '../../../src/modules/admin/llm-strategy.js'
import { createAgentStateLabelOperations } from '../../../src/modules/admin/llm-strategy.js'
import { createApp } from '../../../src/app.js'

test('Admin 状态标签目录需要管理员认证并返回特殊状态和工具标签', async () => {
  const app = Fastify()
  registerAgentStateLabelRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send()
    },
    read: async () => ({
      special: [{ key: '_thinking', default: '', custom: '想一想', label: '想一想' }],
      tools: [{ key: 'search_conversations', default: '搜索对话', custom: '', label: '搜索对话' }],
    }),
    update: async overrides => ({ ok: true, count: Object.keys(overrides).length }),
  })
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/agent/state-labels' })).statusCode, 401)
    const response = await app.inject({ url: '/api/v1/admin/agent/state-labels', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().tools[0].key, 'search_conversations')
  } finally { await app.close() }
})

test('Admin 状态标签更新验证 DTO 并保留 Python 空 overrides 默认值', async () => {
  const app = Fastify()
  const writes: Array<Record<string, string>> = []
  registerAgentStateLabelRoutes(app, {
    requireAdmin: async () => {},
    read: async () => ({ special: [], tools: [] }),
    update: async overrides => { writes.push(overrides); return { ok: true, count: Object.keys(overrides).length } },
  })
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/state-labels', payload: { overrides: { _thinking: ' 改写 ', tool_x: '' } } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(writes, [{ _thinking: ' 改写 ', tool_x: '' }])
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/state-labels', payload: {} })).statusCode, 200)
    assert.deepEqual(writes[1], {})
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/state-labels', payload: { overrides: { bad: 1 } } })).statusCode, 422)
  } finally { await app.close() }
})

test('生产组合保留无关配置，读取排序目录并按 Python 清理覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-state-labels-'))
  const path = join(dir, 'runtime.json')
  await writeFile(path, JSON.stringify({ database: { url: 'sqlite://synthetic' }, state_labels: { overrides: { _thinking: '旧值' } } }))
  let authorized = false
  try {
    const operations = createAgentStateLabelOperations({ path, toolLabels: { z_tool: 'Z 工具', a_tool: 'A 工具' } })
    const app = createApp({
      appName: 'test', isReady: async () => true,
      adminAuth: {
        registerRoutes() {},
        async requireAdmin(_request, reply) { if (!authorized) return reply.code(401).send() },
        async verifyAdmin() { return authorized },
      },
      adminAgentStateLabels: operations,
    })
    try {
      assert.equal((await app.inject({ url: '/api/v1/admin/agent/state-labels' })).statusCode, 401)
      authorized = true
      const catalog = await app.inject({ url: '/api/v1/admin/agent/state-labels' })
      assert.equal(catalog.statusCode, 200)
      assert.deepEqual(catalog.json().tools.map((item: { key: string }) => item.key), ['a_tool', 'z_tool'])
      const update = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/state-labels', payload: {
        overrides: { _thinking: '  自定义  ', a_tool: 'A 工具', old_tool: '遗留工具' },
      } })
      assert.deepEqual(update.json(), { ok: true, count: 2 })
      const saved = JSON.parse(await readFile(path, 'utf8'))
      assert.deepEqual(saved.database, { url: 'sqlite://synthetic' })
      assert.deepEqual(saved.state_labels, { overrides: { _thinking: '自定义', old_tool: '遗留工具' } })
      assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/state-labels', payload: { overrides: { a_tool: 1 } } })).statusCode, 422)
    } finally { await app.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
