import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { agentCommandMenu, registerAgentMiscRoutes } from '../../src/domains/agent-sessions/agent-misc.js'

test('Agent 斜杠命令路由先鉴权，并返回共享命令菜单', async () => {
  const app = Fastify()
  registerAgentMiscRoutes(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    commandMenu() { throw new Error('未认证时不得读取命令菜单') },
    defaultStateLabels: {},
    stateLabelOverrides: () => ({}),
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/commands' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { detail: '未认证' })
  } finally {
    await app.close()
  }
})

test('Agent 斜杠命令路由返回命令定义而不重写内容', async () => {
  const app = Fastify()
  const commands = [{ command: '/help', description: '显示帮助' }, { command: '/stop', description: '停止任务' }]
  registerAgentMiscRoutes(app, {
    async requireUser() {},
    commandMenu() { return commands },
    defaultStateLabels: {},
    stateLabelOverrides: () => ({}),
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/commands' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { commands })
  } finally {
    await app.close()
  }
})

test('状态标签只接受特殊键覆盖，并按竖线或换行拆分候选', async () => {
  const app = Fastify()
  registerAgentMiscRoutes(app, {
    async requireUser() {},
    commandMenu() { return [] },
    defaultStateLabels: { _thinking: '思考中|请稍候', _context_compaction: '整理上下文' },
    stateLabelOverrides: () => ({
      _thinking: '正在思考\n稍等片刻',
      _context_compaction: '压缩历史|继续整理',
      web_search: '不得覆盖普通工具标签',
      _preparing: '',
    }),
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/ui-labels' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      thinking: ['正在思考', '稍等片刻'],
      contextCompacting: ['压缩历史', '继续整理'],
    })
  } finally {
    await app.close()
  }
})

test('规范命令菜单只公开可用命令且保留各自插入文本', async () => {
  const app = Fastify()
  registerAgentMiscRoutes(app, {
    async requireUser() {},
    commandMenu: agentCommandMenu,
    defaultStateLabels: {},
    stateLabelOverrides: () => ({}),
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/commands' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().commands.map((item: { command: string }) => item.command), [
      '/stop', '/status', '/compact', '/goal', '/new', '/memory', '/forget', '/workspace', '/auto', '/help',
    ])
    assert.equal(response.json().commands.find((item: { command: string }) => item.command === '/goal').insert, '/goal ')
  } finally {
    await app.close()
  }
})
