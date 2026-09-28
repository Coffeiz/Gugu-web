import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const scriptPath = new URL('./build-offline-sandbox-bundle.sh', import.meta.url)
const composePath = new URL('../../docker-compose.offline.yml', import.meta.url)

test('offline bundle builder saves only the app and optional integration images', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(script, /--output/)
  assert.match(script, /docker save/)
  assert.match(script, /GUGU_WEB_IMAGE/)
  assert.match(script, /GUGU_SEARCH_IMAGE/)
  assert.doesNotMatch(script, /SANDBOX|egress-proxy|sandbox-bundle-manifest/)

  const workflow = await readFile(new URL('../../.github/workflows/docker-release.yml', import.meta.url), 'utf8')
  const offlineJob = workflow.slice(workflow.indexOf('\n  offline-bundle:'))
  assert.match(offlineJob, /--image coffeiz\/gugu-web:latest[\s\S]*--image searxng\/searxng:latest/)
  assert.doesNotMatch(offlineJob, /gugu-sandbox|ubuntu\/squid|sandbox-bundle-manifest/)
})

test('offline compose never pulls and enables local bundle validation', async () => {
  const compose = await readFile(composePath, 'utf8')
  assert.match(compose, /pull_policy:\s*never/)
  assert.doesNotMatch(compose, /GUGU_SANDBOX_OFFLINE|GUGU_SANDBOX_BUNDLE_MANIFEST/)
  assert.doesNotMatch(compose, /sandbox-bootstrap/)
})
