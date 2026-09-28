import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const releaseDir = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(releaseDir, 'build-offline-sandbox-bundle.sh')
const composePath = new URL('../../docker-compose.offline.yml', import.meta.url)
const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)

test('offline bundle builder defaults to app and search images without a duplicate runtime manifest', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(script, /--output/)
  assert.match(script, /docker save/)
  assert.match(script, /GUGU_WEB_IMAGE/)
  assert.match(script, /GUGU_SEARCH_IMAGE/)
  assert.doesNotMatch(script, /--manifest|GUGU_SANDBOX_IMAGE|GUGU_EGRESS_PROXY_IMAGE|gugu-sandbox|ubuntu\/squid/)
})

test('offline bundle builder inspects and saves only the selected app and search images', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gugu-offline-compose-test-'))
  const bin = path.join(root, 'bin')
  const output = path.join(root, 'release', 'images.tar')
  const dockerLog = path.join(root, 'docker.log')
  const dockerStub = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [[ "$1" == image && "$2" == inspect ]]; then exit 0; fi
if [[ "$1" == save ]]; then
  shift
  if [[ "$1" == -o ]]; then : > "$2"; fi
  exit 0
fi
exit 90
`
  try {
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'docker'), dockerStub, { mode: 0o755 })
    const result = spawnSync('bash', [scriptPath, '--output', output], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MOCK_DOCKER_LOG: dockerLog,
      },
    })
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
    const calls = readFileSync(dockerLog, 'utf8')
    assert.match(calls, /image inspect coffeiz\/gugu-web:latest/)
    assert.match(calls, /image inspect searxng\/searxng:latest/)
    assert.match(calls, /save -o .* coffeiz\/gugu-web:latest searxng\/searxng:latest/)
    assert.doesNotMatch(calls, /gugu-sandbox|squid/)
    assert.equal(existsSync(output), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('offline compose never pulls and relies on the app-bundled sandbox runtime', async () => {
  const compose = await readFile(composePath, 'utf8')
  assert.match(compose, /pull_policy:\s*never/)
  assert.doesNotMatch(compose, /GUGU_SANDBOX_OFFLINE|GUGU_SANDBOX_BUNDLE_MANIFEST/)
  assert.doesNotMatch(compose, /sandbox-bootstrap/)
  assert.doesNotMatch(compose, /^  (?:sandboxd|egress-proxy):/m)
})

test('Docker release invokes the offline bundle builder through bash', async () => {
  const workflow = await readFile(workflowPath, 'utf8')
  assert.match(workflow, /bash scripts\/release\/build-offline-sandbox-bundle\.sh/,
    'bundle builder must not depend on executable file mode in the checkout')
  const offlineJob = workflow.slice(workflow.indexOf('\n  offline-bundle:'))
  assert.match(offlineJob, /docker pull "docker\.io\/coffeiz\/gugu-web:\$\{VERSION\}"/)
  assert.match(offlineJob, /docker pull searxng\/searxng:latest/)
  assert.doesNotMatch(offlineJob, /docker pull .*gugu-sandbox|docker pull ubuntu\/squid|sandbox-bundle-manifest\.json|--manifest/)
})
