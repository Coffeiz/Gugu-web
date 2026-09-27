import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const dockerfilePath = new URL('../../Dockerfile.sandbox-bundle', import.meta.url)
const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)
const bundleActionPath = new URL('../../.github/actions/package-embedded-sandbox-bundle/action.yml', import.meta.url)
const candidateActionPath = new URL('../../.github/actions/assemble-embedded-app-candidate/action.yml', import.meta.url)
const verifierPath = new URL('./verify_embedded_app_image.py', import.meta.url)

test('候选 app 镜像只从既有 app 追加只读 bundle 文件层', async () => {
  const dockerfile = await readFile(dockerfilePath, 'utf8')
  assert.match(dockerfile, /^ARG APP_IMAGE\s+FROM \$\{APP_IMAGE\}/m)
  assert.match(dockerfile, /COPY --chmod=0444 runtime-images\.tar manifest\.json \/opt\/gugu\/sandbox-bundle\//)
  assert.doesNotMatch(dockerfile, /^RUN\b|^ENV\b|^ENTRYPOINT\b|^CMD\b|^LABEL\b|^USER\b|^WORKDIR\b|^EXPOSE\b/m)
})

test('bundle job 只交接通过扫描的 runtime artifact，不串行化 app 构建', async () => {
  const [workflow, bundleAction] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(bundleActionPath, 'utf8'),
  ])
  const sandboxJob = workflow.slice(workflow.indexOf('\n  sandbox-build:'), workflow.indexOf('\n  sandbox-bundle:'))
  const bundleJob = workflow.slice(workflow.indexOf('\n  sandbox-bundle:'), workflow.indexOf('\n  docker-build:'))
  const appJob = workflow.slice(workflow.indexOf('\n  docker-build:'), workflow.indexOf('\n  assemble-candidate:'))

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

test('候选 app 从已构建基础镜像追加 bundle 并验证配置与运行内容', async () => {
  const [workflow, candidateAction, verifier] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(candidateActionPath, 'utf8'),
    readFile(verifierPath, 'utf8'),
  ])
  const candidateJob = workflow.slice(workflow.indexOf('\n  assemble-candidate:'), workflow.indexOf('\n  publish:'))

  assert.match(candidateJob, /needs: \[docker-build, sandbox-bundle\]/)
  assert.match(candidateJob, /uses: \.\/\.github\/actions\/assemble-embedded-app-candidate/)
  assert.match(candidateAction, /context: release\/embedded-bundle/)
  assert.match(candidateAction, /APP_IMAGE=\$\{\{ inputs\.base-image \}\}/)
  assert.match(candidateAction, /verify_embedded_app_image\.py/)
  assert.match(verifier, /"--network", "none"/)
  assert.match(candidateAction, /crane manifest --platform linux\/amd64/)
})
