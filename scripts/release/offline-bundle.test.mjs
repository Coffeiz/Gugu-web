import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const scriptPath = new URL('./build-offline-sandbox-bundle.sh', import.meta.url)
const composePath = new URL('../../docker-compose.offline.yml', import.meta.url)
const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)

test('offline bundle builder saves declared runtime images and writes a manifest', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(script, /--output/)
  assert.match(script, /--manifest/)
  assert.match(script, /docker save/)
  assert.match(script, /RepoDigests/)
  assert.match(script, /image_id/)
  assert.match(script, /if not digest:/)
})

test('offline compose never pulls and enables local bundle validation', async () => {
  const compose = await readFile(composePath, 'utf8')
  assert.match(compose, /pull_policy:\s*never/)
  assert.match(compose, /GUGU_SANDBOX_OFFLINE:\s*["']?1/)
  assert.match(compose, /GUGU_SANDBOX_BUNDLE_MANIFEST/)
  assert.doesNotMatch(compose, /sandbox-bootstrap/)
})

test('Docker release invokes the offline bundle builder through bash', async () => {
  const workflow = await readFile(workflowPath, 'utf8')
  assert.match(workflow, /bash scripts\/release\/build-offline-sandbox-bundle\.sh/,
    'bundle builder must not depend on executable file mode in the checkout')
})
