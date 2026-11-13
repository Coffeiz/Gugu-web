import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../../src/app.js'

test('Node WebUI serves both Vite entries, SPA history paths, and keeps missing APIs as 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-webui-static-'))
  await mkdir(join(root, 'assets'))
  await mkdir(join(root, 'admin', 'assets'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<main>main-app</main>')
  await writeFile(join(root, 'admin', 'index.html'), '<main>admin-app</main>')
  await writeFile(join(root, 'assets', 'main.js'), 'window.mainApp = true')
  await writeFile(join(root, 'admin', 'assets', 'admin.js'), 'window.adminApp = true')
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    staticRoot: root,
    publicSiteConfig: {
      icpNumber: '',
      icpUrl: 'https://beian.miit.gov.cn/',
      passwordResetEnabled: false,
      registrationVerificationEnabled: false,
    },
  })

  try {
    for (const [url, marker] of [
      ['/', 'main-app'],
      ['/projects/42', 'main-app'],
      ['/admin', 'admin-app'],
      ['/admin/settings/providers', 'admin-app'],
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } })
      assert.equal(response.statusCode, 200, url)
      assert.match(response.headers['content-type'] ?? '', /text\/html/)
      assert.match(response.body, new RegExp(marker), url)
    }

    const asset = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' })
    assert.equal(asset.statusCode, 200)
    assert.match(asset.headers['content-type'] ?? '', /javascript/)
    assert.match(asset.body, /adminApp/)

    const siteConfig = await app.inject({ method: 'GET', url: '/api/v1/site-config' })
    assert.equal(siteConfig.statusCode, 200)
    assert.equal(siteConfig.json().icpUrl, 'https://beian.miit.gov.cn/')

    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { status: 'ok', app: 'Gugu' })

    const missingApi = await app.inject({
      method: 'GET', url: '/api/v1/missing', headers: { accept: 'text/html' },
    })
    assert.equal(missingApi.statusCode, 404)
    assert.match(missingApi.headers['content-type'] ?? '', /application\/json/)
    assert.deepEqual(missingApi.json(), {
      message: 'Route GET:/api/v1/missing not found',
      error: 'Not Found',
      statusCode: 404,
    })
    assert.doesNotMatch(missingApi.body, /main-app|admin-app/)

    const missingAsset = await app.inject({
      method: 'GET', url: '/assets/missing.js', headers: { accept: 'text/html' },
    })
    assert.equal(missingAsset.statusCode, 404)
    assert.doesNotMatch(missingAsset.body, /main-app|admin-app/)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
