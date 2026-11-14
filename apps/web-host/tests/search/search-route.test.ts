import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'
import {
  normalizeGlobalSearchQueries,
  parseGlobalSearchQuery,
} from '../../src/domains/search/search.js'

test('global search normalizes repeated keywords with the Python limits and AND/OR fallback', () => {
  assert.deepEqual(normalizeGlobalSearchQueries('', ['部署', ' 部署 ', '上线']), ['部署', '上线'])
  assert.deepEqual(normalizeGlobalSearchQueries('旧入口', []), ['旧入口'])
  assert.equal(normalizeGlobalSearchQueries('', ['x'.repeat(70)])[0]?.length, 64)
  assert.equal(normalizeGlobalSearchQueries('', Array.from({ length: 10 }, (_, index) => `q${index}`)).length, 8)
  assert.deepEqual(parseGlobalSearchQuery({ mode: 'unexpected' }), {
    q: '', queries: [], mode: 'OR', perType: 6, types: null,
  })
})

test('global search route requires authentication and forwards owner plus normalized filters', async () => {
  const secret = 'synthetic-search-secret'
  const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
  const calls: unknown[][] = []
  const app = createApp({
    appName: 'Gugu global search test',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return {
          id, username: 'synthetic-user', displayName: null, email: 'synthetic@example.test',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        }
      },
    },
    globalSearch: {
      async search(ownerId, query) {
        calls.push([ownerId, query])
        return { query: query.q, queries: query.queries, mode: query.mode, total: 0, groups: [] }
      },
    },
  })
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/search?queries=部署' })
    assert.equal(unauthorized.statusCode, 401)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/search?mode=AND&per_type=12&types=file&types=note&queries=%E9%83%A8%E7%BD%B2&queries=%E4%B8%8A%E7%BA%BF',
      headers: { authorization: `Bearer ${signedUserToken(secret, ownerId)}` },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(calls, [[ ownerId, {
      q: '', queries: ['部署', '上线'], mode: 'AND', perType: 12, types: ['file', 'note'],
    } ]])
  } finally {
    await app.close()
  }
})

test('global search rejects malformed pagination before calling persistence', async () => {
  assert.throws(() => parseGlobalSearchQuery({ per_type: '201' }), /per_type/)
  assert.throws(() => parseGlobalSearchQuery({ per_type: '1.5' }), /per_type/)
  assert.throws(() => parseGlobalSearchQuery({ queries: ['ok', 12] }), /搜索关键词/)
})
