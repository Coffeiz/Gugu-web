import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'

test('GET /api/v1/site-config is public and preserves Python defaults', async () => {
  const app = createApp({ appName: 'Gugu', isReady: async () => true })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/site-config' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      icpNumber: '',
      icpUrl: 'https://beian.miit.gov.cn/',
      passwordResetEnabled: false,
      registrationVerificationEnabled: false,
    })
  } finally {
    await app.close()
  }
})

test('GET /api/v1/site-config exposes configured public fields without requiring a session', async () => {
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    publicSiteConfig: {
      icpNumber: '京ICP备00000000号',
      icpUrl: 'https://beian.example.test/',
      passwordResetEnabled: true,
      registrationVerificationEnabled: true,
    },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/site-config' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      icpNumber: '京ICP备00000000号',
      icpUrl: 'https://beian.example.test/',
      passwordResetEnabled: true,
      registrationVerificationEnabled: true,
    })
  } finally {
    await app.close()
  }
})
