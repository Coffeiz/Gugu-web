import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const dockerfilePath = new URL('../../Dockerfile.sandbox-bundle', import.meta.url)
const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)
const bundleActionPath = new URL('../../.github/actions/package-embedded-sandbox-bundle/action.yml', import.meta.url)

test('候选 app 镜像只从既有 app 追加只读 bundle 文件层', async () => {
  const dockerfile = await readFile(dockerfilePath, 'utf8')
  assert.match(dockerfile, /^ARG APP_IMAGE\s+FROM \$\{APP_IMAGE\}/m)
  assert.match(dockerfile, /COPY --chmod=0444 release\/embedded-bundle\/runtime-images\.tar \/opt\/gugu\/sandbox-bundle\/runtime-images\.tar/)
  assert.match(dockerfile, /COPY --chmod=0444 release\/embedded-bundle\/manifest\.json \/opt\/gugu\/sandbox-bundle\/manifest\.json/)
  assert.doesNotMatch(dockerfile, /^RUN\b|^ENV\b|^ENTRYPOINT\b|^CMD\b|^LABEL\b|^USER\b|^WORKDIR\b|^EXPOSE\b/m)
})

test('bundle job 只交接通过扫描的 runtime artifact，不串行化 app 构建', async () => {
  const [workflow, bundleAction] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(bundleActionPath, 'utf8'),
  ])
  const sandboxJob = workflow.slice(workflow.indexOf('\n  sandbox-build:'), workflow.indexOf('\n  sandbox-bundle:'))
  const bundleJob = workflow.slice(workflow.indexOf('\n  sandbox-bundle:'), workflow.indexOf('\n  docker-build:'))
  const appJob = workflow.slice(workflow.indexOf('\n  docker-build:'), workflow.indexOf('\n  publish:'))

  assert.match(sandboxJob, /Scan immutable sandbox image/)
  assert.match(sandboxJob, /image_digest: \$\{\{ steps\.runtime-image\.outputs\.digest \}\}/)
  assert.match(bundleJob, /needs: sandbox-build/)
  assert.match(bundleJob, /uses: \.\/\.github\/actions\/package-embedded-sandbox-bundle/)
  assert.match(bundleJob, /sandbox-image-digest: \$\{\{ needs\.sandbox-build\.outputs\.image_digest \}\}/)
  assert.match(bundleAction, /SANDBOX_DIGEST: \$\{\{ inputs\.sandbox-image-digest \}\}/)
  assert.match(bundleAction, /Scan immutable egress proxy image[\s\S]*Build embedded runtime bundle/)
  assert.match(bundleAction, /Upload embedded runtime bundle[\s\S]*actions\/upload-artifact@v4/)
  assert.ok(bundleAction.indexOf('Scan immutable egress proxy image') < bundleAction.indexOf('Build embedded runtime bundle'))
  assert.ok(bundleAction.indexOf('Build embedded runtime bundle') < bundleAction.indexOf('Upload embedded runtime bundle'))
  assert.match(appJob, /needs: compose-validate/)
  assert.doesNotMatch(appJob, /needs:.*sandbox-bundle/)
})
