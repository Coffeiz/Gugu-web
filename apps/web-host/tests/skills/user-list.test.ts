import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const ownerId = '00000000-0000-4000-8000-000000000101'
const secret = 'synthetic-skill-list-secret'
const apps: Array<{ close(): Promise<void> }> = []
const skillRow = (name: string, body: string, digest = 'digest') => ({
  id: 'U1', name, description_short: '摘要', description_long: null, category: 'personal',
  related_tools: [], body, source: 'user', managed_by: 'user', enabled: true,
  content_digest: digest, created_at: null, updated_at: null,
})

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })

test('Skills first-load returns owner skill rows without triggering tool discovery', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: 'Synthetic skill list app', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: null, email: 'sample@example.invalid', avatarUrl: null,
          createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    userSkillList: {
      async list(owner) { calls.push(['list', owner]); return [skillRow('笔记整理', 'private skill body')] },
    },
  })
  apps.push(app)

  const unauthorized = await app.inject({ url: '/api/v1/skills?include_tools=false' })
  const response = await app.inject({
    url: '/api/v1/skills?include_tools=false',
    headers: { authorization: `Bearer ${createUserToken(ownerId, 1, secret)}` },
  })

  assert.equal(unauthorized.statusCode, 401)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { skills: [skillRow('笔记整理', 'private skill body')], tools: [] })
  assert.deepEqual(calls, [['list', ownerId]])
})

test('Skill 工具目录默认列表与按需路由都使用认证 owner', async () => {
  const owners: string[] = []
  const app = createApp({
    appName: 'Synthetic skill tools app', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: null, email: 'sample@example.invalid', avatarUrl: null,
          createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    userSkillList: {
      async list(owner) { return [skillRow('技能', 'private skill body', owner)] },
      async tools(owner) { owners.push(owner); return [
        { name: 'web_search', description_short: '查找资料', category: 'other', enabled: true },
        { name: 'mcp_gaode_geocode', description_short: '地理编码', category: 'mcp', enabled: true },
      ] },
    },
  })
  apps.push(app)

  const unauthorized = await app.inject({ url: '/api/v1/skills/tools' })
  const listed = await app.inject({
    url: '/api/v1/skills', headers: { authorization: `Bearer ${createUserToken(ownerId, 1, secret)}` },
  })
  const tools = await app.inject({
    url: '/api/v1/skills/tools', headers: { authorization: `Bearer ${createUserToken(ownerId, 1, secret)}` },
  })
  assert.equal(unauthorized.statusCode, 401)
  assert.equal(listed.statusCode, 200)
  assert.deepEqual(listed.json().tools, [
    { name: 'web_search', description_short: '查找资料', category: 'other', enabled: true },
    { name: 'mcp_gaode_geocode', description_short: '地理编码', category: 'mcp', enabled: true },
  ])
  assert.equal(tools.statusCode, 200)
  assert.deepEqual(tools.json(), { tools: listed.json().tools })
  assert.deepEqual(owners, [ownerId, ownerId])
})
