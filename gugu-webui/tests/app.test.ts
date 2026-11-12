import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../src/app.js'

const apps: Array<{ close(): Promise<void> }> = []

function testApp(options: Parameters<typeof createApp>[0]) {
  const app = createApp(options)
  apps.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

test('GET /health preserves the existing Web health response', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({ method: 'GET', url: '/health' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok', app: '合成测试应用' })
})

test('GET /health/ready reports an unavailable data runtime without claiming readiness', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => false })

  const response = await app.inject({ method: 'GET', url: '/health/ready' })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { status: 'not_ready' })
})

test('GET /health/ready reports readiness only after the data runtime is available', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({ method: 'GET', url: '/health/ready' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok' })
})

test('GET /health/ready hides readiness dependency errors from HTTP clients', async () => {
  let reportedFailure = false
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => {
      throw new Error('synthetic database credential detail')
    },
    onReadinessError: () => {
      reportedFailure = true
    },
  })

  const response = await app.inject({ method: 'GET', url: '/health/ready' })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { status: 'not_ready' })
  assert.equal(response.body.includes('synthetic database credential detail'), false)
  assert.equal(reportedFailure, true)
})
