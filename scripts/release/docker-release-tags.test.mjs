import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)

test('正式镜像只发布语义版本号标签，Git SHA 仅保留为构建元数据', async () => {
  const workflow = await readFile(workflowPath, 'utf8')
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:\n'))
  const imageTagLines = publishJob.split('\n').filter(line =>
    /^\s*\$\{\{\s*env\.[A-Z_]+\s*\}\}[^\n]*:\$\{\{/.test(line),
  )

  assert.equal(imageTagLines.length, 8, '预期 backend、frontend、app、sandbox 发布共八个版本标签（updater 与 app 同镜像）')
  assert.ok(imageTagLines.every(line => line.includes('steps.version.outputs.version')))
  assert.ok(imageTagLines.every(line => !line.includes('github.sha')))
  assert.match(publishJob, /\$\{\{\s*env\.IMAGE_REPOSITORY\s*\}\}-backend:\$\{\{\s*steps\.version\.outputs\.version\s*\}\}/)
  assert.match(publishJob, /\$\{\{\s*env\.IMAGE_REPOSITORY\s*\}\}-frontend:\$\{\{\s*steps\.version\.outputs\.version\s*\}\}/)
  assert.match(publishJob, /\$\{\{\s*env\.DOCKERHUB_BACKEND_IMAGE_REPOSITORY\s*\}\}:\$\{\{\s*steps\.version\.outputs\.version\s*\}\}/)
  assert.match(publishJob, /\$\{\{\s*env\.DOCKERHUB_FRONTEND_IMAGE_REPOSITORY\s*\}\}:\$\{\{\s*steps\.version\.outputs\.version\s*\}\}/)
  assert.match(publishJob, /uses: sigstore\/cosign-installer@v3\.8\.1\s+with:\s+cosign-release: v3\.1\.3/)
  const imageSignCommands = publishJob.split('\n').filter(line => line.includes('cosign sign --yes'))
  assert.equal(imageSignCommands.length, 8, '所有 GHCR 与 Docker Hub 镜像都应签名（updater 与 app 同镜像不单签）')
  assert.ok(imageSignCommands.every(line => line.includes('--registry-referrers-mode=oci-1-1')),
    '镜像签名应以 OCI 1.1 referrer 保存，不生成 sha256-*.sig 普通 tag')
  assert.match(publishJob, /cosign sign --yes --registry-referrers-mode=oci-1-1 "\$\{DOCKERHUB_BACKEND_IMAGE_REPOSITORY\}@\$\{BACKEND_DIGEST\}"/)
  assert.match(publishJob, /cosign sign --yes --registry-referrers-mode=oci-1-1 "\$\{DOCKERHUB_FRONTEND_IMAGE_REPOSITORY\}@\$\{FRONTEND_DIGEST\}"/)
  assert.match(publishJob, /GIT_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/, 'manifest 仍应记录构建 commit SHA')
  assert.match(publishJob, /--tag "\$\{IMAGE_REPOSITORY\}:latest"/, '稳定版需继续更新默认部署使用的 latest 别名')
})
