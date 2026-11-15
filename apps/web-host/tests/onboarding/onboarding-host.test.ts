import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken, type PublicUserRecord } from '../../src/domains/auth/auth.js'
import { onboardingResponse, type OnboardingStore } from '@gugu/core/onboarding'

const ownerId = '00000000-0000-4000-8000-000000000061'
const otherOwnerId = '00000000-0000-4000-8000-000000000062'
const secret = 'synthetic-test-secret-for-onboarding'

test('历史引导状态按 Python 规则处理重复步骤和空容器', () => {
  const response = onboardingResponse({
    seed: { seeded: true },
    guide: { enabled: ['legacy'], dismissed: {}, completed_at: [], version: 1,
      completed_steps: ['locale', 'locale', 'invalid'] },
  }) as { should_show: boolean; guide: { enabled: boolean; dismissed: boolean; completed_steps: string[] } }
  assert.equal(response.should_show, true)
  assert.equal(response.guide.enabled, true)
  assert.equal(response.guide.dismissed, false)
  assert.deepEqual(response.guide.completed_steps, ['locale', 'locale'])
  const legacy = onboardingResponse({ seeded: true, guide_enabled: true, current_step: 'model' })
  assert.equal('guide_enabled' in legacy, false)
  assert.equal('current_step' in legacy, false)
  for (const [version, expected] of [['2.5', 1], ['0x2', 1], [[2], 1], [2.5, 2], ['  +2  ', 2]] as const) {
    const result = onboardingResponse({ guide: { version } }) as { guide: { version: number } }
    assert.equal(result.guide.version, expected)
  }
})
const makeUser = (id: string): PublicUserRecord => ({
  id,
  username: `onboarding-${id.slice(-2)}`,
  displayName: '引导测试用户',
  email: `onboarding-${id.slice(-2)}@example.test`,
  isActive: true,
  accountStatus: 'active',
  securityVersion: 1,
  avatarUrl: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  timezone: 'Asia/Shanghai',
  emailSubscribed: false,
  imChannels: [],
})

test('Node Host onboarding state is authenticated, owner-scoped, and reopens without losing progress or seed data', async () => {
  const states = new Map<string, Record<string, unknown>>([
    [ownerId, {
      seed: { seeded: true, project_id: 17, project_name: '示例项目' },
      guide: {
        enabled: true, version: 1, current_step: 'model', completed_steps: ['locale', 'features'],
        dismissed: true, completed_at: null,
      },
    }],
  ])
  const touched: string[] = []
  const store: OnboardingStore = {
    async getState(userId) {
      touched.push(userId)
      return states.get(userId) ?? {
        seed: { seeded: false, project_id: null, project_name: null },
        guide: { enabled: false, version: 1, current_step: 'locale', completed_steps: [], dismissed: false, completed_at: null },
      }
    },
    async updateGuide(userId, patch) {
      touched.push(userId)
      const current = states.get(userId) ?? {
        seed: { seeded: false, project_id: null, project_name: null },
        guide: { enabled: false, version: 1, current_step: 'locale', completed_steps: [], dismissed: false, completed_at: null },
      }
      const next = { ...current, guide: { ...(current.guide as Record<string, unknown>), ...patch } }
      states.set(userId, next)
      return next
    },
  }
  const users = new Map([[ownerId, makeUser(ownerId)], [otherOwnerId, makeUser(otherOwnerId)]])
  const app = createApp({
    appName: 'onboarding-host-test',
    async isReady() { return true },
    userAuth: { secret, async lookupUser(userId) { return users.get(userId) ?? null } },
    onboarding: store,
  })

  try {
    const ready = await app.inject({ method: 'GET', url: '/health/ready' })
    assert.equal(ready.statusCode, 200)

    const denied = await app.inject({ method: 'GET', url: '/api/v1/onboarding/state' })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(touched, [])

    const ownerAuthorization = `Bearer ${createUserToken(ownerId, 1, secret)}`
    const otherAuthorization = `Bearer ${createUserToken(otherOwnerId, 1, secret)}`
    const current = await app.inject({
      method: 'GET', url: '/api/v1/onboarding/state', headers: { authorization: ownerAuthorization },
    })
    assert.equal(current.statusCode, 200)
    assert.equal(current.json().should_show, false)
    assert.equal(current.json().seed.project_id, 17)

    const updated = await app.inject({
      method: 'PATCH', url: '/api/v1/onboarding/state',
      headers: { authorization: ownerAuthorization },
      payload: { current_step: 'style', completed_steps: ['locale', 'locale', 'features'], dismissed: false },
    })
    assert.equal(updated.statusCode, 200)
    assert.deepEqual(updated.json().guide.completed_steps, ['locale', 'features'])
    assert.equal(updated.json().should_show, true)

    const invalid = await app.inject({
      method: 'PATCH', url: '/api/v1/onboarding/state',
      headers: { authorization: ownerAuthorization }, payload: { seeded: false },
    })
    assert.equal(invalid.statusCode, 422)
    const invalidVersion = await app.inject({
      method: 'PATCH', url: '/api/v1/onboarding/state',
      headers: { authorization: ownerAuthorization }, payload: { guide_version: null },
    })
    assert.equal(invalidVersion.statusCode, 422)
    const fractionalVersion = await app.inject({
      method: 'PATCH', url: '/api/v1/onboarding/state',
      headers: { authorization: ownerAuthorization }, payload: { guide_version: '1.5' },
    })
    assert.equal(fractionalVersion.statusCode, 422)
    const numericFractionalVersion = await app.inject({
      method: 'PATCH', url: '/api/v1/onboarding/state',
      headers: { authorization: ownerAuthorization }, payload: { guide_version: 1.5 },
    })
    assert.equal(numericFractionalVersion.statusCode, 422)

    const reopened = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/state/reopen', headers: { authorization: ownerAuthorization },
    })
    assert.equal(reopened.statusCode, 200)
    assert.deepEqual(reopened.json().guide.completed_steps, ['locale', 'features'])
    assert.equal(reopened.json().seed.project_name, '示例项目')
    assert.equal(reopened.json().should_show, true)

    const other = await app.inject({
      method: 'GET', url: '/api/v1/onboarding/state', headers: { authorization: otherAuthorization },
    })
    assert.equal(other.statusCode, 200)
    assert.equal(other.json().seed.project_id, null)
    assert.equal(other.json().should_show, false)
    assert.deepEqual(touched, [ownerId, ownerId, ownerId, otherOwnerId])
  } finally {
    await app.close()
  }
})
