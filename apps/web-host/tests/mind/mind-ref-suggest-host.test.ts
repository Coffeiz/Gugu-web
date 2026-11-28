import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-mind-ref-suggest-secret'
const userId = 'd1e37042-3229-4cbe-a260-a63dcb95e001'

test('Mind reference suggestions authenticate, bind the verified owner, and validate query bounds', async () => {
  const calls: unknown[][] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret,
      lookupUser: async (id) => ({
        id, username: 'sample-user', displayName: null, email: 'sample@example.test',
        isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null,
        createdAt: null, timezone: null, emailSubscribed: false, imChannels: [],
      }),
    },
    mindRefSuggest: {
      async suggest(...args) {
        calls.push(args)
        return [{ type: 'project', id: 7, label: '示例项目', subtitle: '小北' }]
      },
    },
  })

  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/mind/ref-suggest' })
    const headers = { authorization: `Bearer ${signedUserToken(secret, userId)}` }
    const defaultQuery = await app.inject({ method: 'GET', url: '/api/v1/mind/ref-suggest?q=%20计划%20', headers })
    const explicitLimit = await app.inject({ method: 'GET', url: '/api/v1/mind/ref-suggest?limit=20', headers })
    const tooSmall = await app.inject({ method: 'GET', url: '/api/v1/mind/ref-suggest?limit=0', headers })
    const tooLarge = await app.inject({ method: 'GET', url: '/api/v1/mind/ref-suggest?limit=21', headers })
    const malformedLimit = await app.inject({ method: 'GET', url: '/api/v1/mind/ref-suggest?limit=abc', headers })
    const malformedQuery = await app.inject({ method: 'GET', url: '/api/v1/mind/ref-suggest?q=x&q=y', headers })

    assert.equal(unauthorized.statusCode, 401)
    assert.equal(defaultQuery.statusCode, 200)
    assert.deepEqual(defaultQuery.json(), [{ type: 'project', id: 7, label: '示例项目', subtitle: '小北' }])
    assert.equal(explicitLimit.statusCode, 200)
    assert.deepEqual(calls, [[userId, ' 计划 ', 6], [userId, '', 20]])
    assert.equal(tooSmall.statusCode, 422)
    assert.equal(tooLarge.statusCode, 422)
    assert.equal(malformedLimit.statusCode, 422)
    assert.equal(malformedQuery.statusCode, 422)
  } finally {
    await app.close()
  }
})
