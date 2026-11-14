import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminSafeEgressReadRoute } from '../../src/domains/admin/admin-safe-egress-read.js'

function setup(authorized = true) {
  let reads = 0
  const app = Fastify()
  registerAdminSafeEgressReadRoute(app, {
    requireAdmin: async (request, reply) => {
      if (!authorized || request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '未授权' })
    },
    readSettings: () => {
      reads++
      return { enabled: true, proxy_url: 'http://proxy.example.invalid:3128', proxy_auth_secret: 'encrypted-secret-must-not-leak' }
    },
  })
  return { app, get reads() { return reads }, close: () => app.close() }
}

test('未授权的安全出站配置请求在读取配置前拒绝', async () => {
  const ctx = setup(false)
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/safe-egress' })
    assert.equal(response.statusCode, 401)
    assert.equal(ctx.reads, 0)
  } finally { await ctx.close() }
})

test('管理员只获得代理开关、地址及凭据存在标记，不返回密钥', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/safe-egress', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      enabled: true,
      proxy_url: 'http://proxy.example.invalid:3128',
      has_auth: true,
    })
    assert.equal(response.body.includes('encrypted-secret-must-not-leak'), false)
    assert.equal(ctx.reads, 1)
  } finally { await ctx.close() }
})

test('没有代理凭据时 has_auth 为 false', async () => {
  const app = Fastify()
  registerAdminSafeEgressReadRoute(app, {
    requireAdmin: async () => {},
    readSettings: () => ({ enabled: false, proxy_url: '', proxy_auth_secret: '' }),
  })
  try {
    const response = await app.inject({ url: '/api/v1/admin/safe-egress' })
    assert.deepEqual(response.json(), { enabled: false, proxy_url: '', has_auth: false })
  } finally { await app.close() }
})

test('拒绝回显旧配置中嵌入代理 URL 的账号密码', async () => {
  const app = Fastify()
  registerAdminSafeEgressReadRoute(app, {
    requireAdmin: async () => {},
    readSettings: () => ({
      enabled: true,
      proxy_url: 'http://legacy-user:legacy-password@proxy.example.invalid:3128',
      proxy_auth_secret: '',
    }),
  })
  try {
    const response = await app.inject({ url: '/api/v1/admin/safe-egress' })
    assert.equal(response.statusCode, 500)
    assert.doesNotMatch(response.body, /legacy-user|legacy-password/)
  } finally { await app.close() }
})
