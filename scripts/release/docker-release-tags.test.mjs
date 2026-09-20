import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)
const composePath = new URL('../../docker-compose.yml', import.meta.url)
const appDockerfilePath = new URL('../../Dockerfile', import.meta.url)

test('一体化 Compose 使用随 app 镜像交付的 Sandbox bundle', async () => {
  const [compose, dockerfile] = await Promise.all([
    readFile(composePath, 'utf8'),
    readFile(appDockerfilePath, 'utf8'),
  ])
  assert.equal((compose.match(/SANDBOX__IMAGE: \$\{GUGU_SANDBOX_IMAGE:-coffeiz\/gugu-sandbox:bundled\}/g) ?? []).length, 3,
    'app、sandbox-bootstrap 与 sandboxd 应默认引用内嵌 Sandbox tag')
  assert.equal((compose.match(/SANDBOX__IMAGE_DIGEST: \$\{GUGU_SANDBOX_IMAGE_DIGEST:-bundled\}/g) ?? []).length, 3,
    '三处 Compose 配置都应启用 bundle image ID 校验')
  assert.match(dockerfile, /COPY docker\/sandbox\/bundle\/sandbox-image\.tar\.gz \/opt\/gugu\/sandbox\/sandbox-image\.tar\.gz/)
  assert.match(dockerfile, /COPY docker\/sandbox\/bundle\/image-id \/opt\/gugu\/sandbox\/image-id/)
})

test('正式镜像只发布语义版本号标签，Git SHA 仅保留为构建元数据', async () => {
  const workflow = await readFile(workflowPath, 'utf8')
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:\n'))

  // 发布不再重建镜像：publish 从 docker-build 推送的 :ci-<run_id> 纯复制，
  // 保证 trivy 扫过的 digest 与发布的 digest 一致。
  assert.match(publishJob, /CI_SUFFIX: ci-\$\{\{\s*github\.run_id\s*\}\}/)
  const copyLines = publishJob.split('\n').filter(line => line.trim().startsWith('crane copy '))
  assert.equal(copyLines.length, 8, 'backend、frontend、app、sandbox 各复制到 GHCR 与 Docker Hub 共八次')
  // 版本 tag 全部使用发布版本号变量，Git SHA 不允许进入任何 tag。
  assert.ok(copyLines.every(line => line.includes(':${VERSION}') && !line.includes('github.sha')),
    '发布 tag 必须来自版本号变量')
  // 四个发布镜像在两个 registry 的 digest 都要解析，供签名与 updater manifest 使用。
  for (const key of [
    'ghcr_backend', 'ghcr_frontend', 'ghcr_app', 'ghcr_sandbox',
    'hub_backend', 'hub_frontend', 'hub_app', 'hub_sandbox',
  ]) {
    assert.match(publishJob, new RegExp(`echo "${key}=\\$\\(crane digest `), `缺少 digest 解析：${key}`)
  }
  // 稳定版 latest 别名改由 crane tag 打点。
  assert.match(publishJob, /crane tag "\$\{IMAGE_REPOSITORY\}:\$\{VERSION\}" latest/,
    '稳定版需继续更新默认部署使用的 latest 别名')
  assert.match(workflow, /push: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/,
    ':ci 中间镜像只在 tag 触发时推送，main/dispatch 运行零额外推送')
  assert.match(workflow, /name: bundled-sandbox-runtime[\s\S]*?path:[\s\S]*?sandbox-image\.tar\.gz[\s\S]*?image-id/,
    '发布流水线必须把已扫描的 Sandbox 镜像归档和 image ID 传给 app 构建')
  assert.match(workflow, /Download bundled sandbox runtime[\s\S]*?path: docker\/sandbox\/bundle/,
    '一体化 app 构建必须消费 Sandbox bundle')

  assert.match(publishJob, /uses: sigstore\/cosign-installer@v4\.1\.2\s+with:\s+cosign-release: v3\.1\.3/)
  // cosign 3.x 的 oci-1-1 referrers 模式在实验开关后面，缺 env 直接报 invalid argument
  assert.match(publishJob, /COSIGN_EXPERIMENTAL:\s*'1'/,
    '签名步骤必须设置 COSIGN_EXPERIMENTAL=1，否则 --registry-referrers-mode=oci-1-1 被拒')
  const imageSignCommands = publishJob.split('\n').filter(line => line.includes('cosign sign --yes'))
  assert.equal(imageSignCommands.length, 8, '所有 GHCR 与 Docker Hub 镜像都应签名（updater 与 app 同镜像不单签）')
  assert.ok(imageSignCommands.every(line => line.includes('--registry-referrers-mode=oci-1-1')),
    '镜像签名应以 OCI 1.1 referrer 保存，不生成 sha256-*.sig 普通 tag')
  assert.match(publishJob, /cosign sign --yes --registry-referrers-mode=oci-1-1 "\$\{DOCKERHUB_BACKEND_IMAGE_REPOSITORY\}@\$\{BACKEND_DIGEST\}"/)
  assert.match(publishJob, /cosign sign --yes --registry-referrers-mode=oci-1-1 "\$\{DOCKERHUB_FRONTEND_IMAGE_REPOSITORY\}@\$\{FRONTEND_DIGEST\}"/)
  assert.match(publishJob, /GIT_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/, 'manifest 仍应记录构建 commit SHA')
})
