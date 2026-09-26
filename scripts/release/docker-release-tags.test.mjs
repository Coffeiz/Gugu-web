import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)
const composePath = new URL('../../docker-compose.yml', import.meta.url)
const appDockerfilePath = new URL('../../Dockerfile', import.meta.url)

test('一体化镜像不内嵌 Sandbox，默认 Compose 启动独立沙盒并解析镜像 digest', async () => {
  const [compose, dockerfile] = await Promise.all([
    readFile(composePath, 'utf8'),
    readFile(appDockerfilePath, 'utf8'),
  ])
  assert.equal((compose.match(/SANDBOX__IMAGE: \$\{GUGU_SANDBOX_IMAGE:-coffeiz\/gugu-sandbox:latest\}/g) ?? []).length, 2,
    'app 与 sandboxd 应默认使用已发布沙盒镜像')
  assert.equal((compose.match(/SANDBOX__IMAGE_DIGEST: \$\{GUGU_SANDBOX_IMAGE_DIGEST:-resolved\}/g) ?? []).length, 2,
    'app 与 sandboxd 应使用 sandboxd 初始化解析的固定 digest')
  assert.doesNotMatch(compose, /profiles:\s*\[sandbox\]/,
    '默认 Compose 必须启动 egress-proxy 和 sandboxd')
  assert.doesNotMatch(dockerfile, /docker\/sandbox\/bundle|\/opt\/gugu\/sandbox\//,
    '一体化镜像不得包含 Sandbox bundle')
})

test('正式发布提供单 tar 离线沙盒 bundle', async () => {
  const workflow = await readFile(workflowPath, 'utf8')
  assert.match(workflow, /offline-bundle:/)
  assert.match(workflow, /build-offline-sandbox-bundle\.sh/)
  assert.match(workflow, /actions\/upload-artifact@v4/)
})

test('app 镜像的动态版本元数据不使文件系统层缓存失效', async () => {
  const dockerfile = await readFile(appDockerfilePath, 'utf8')
  const runtimeStage = dockerfile.slice(dockerfile.indexOf('# ── Stage 3'))
  const filesystemInstructions = [...runtimeStage.matchAll(/^(?:RUN|COPY|ADD)\b/gm)]
  const lastFilesystemInstruction = filesystemInstructions.at(-1)?.index ?? -1
  const versionArg = runtimeStage.indexOf('ARG GUGU_VERSION=unknown')
  const revisionArg = runtimeStage.indexOf('ARG GUGU_REVISION=unknown')
  const labels = runtimeStage.indexOf('LABEL org.opencontainers.image.version=')

  assert.ok(lastFilesystemInstruction >= 0, '运行时阶段应包含文件系统构建指令')
  assert.ok(lastFilesystemInstruction < versionArg,
    '动态版本参数必须放在所有 RUN/COPY/ADD 之后，避免提交 SHA 变化使文件层缓存失效')
  assert.ok(versionArg < revisionArg && revisionArg < labels,
    '版本参数应在最终镜像标签之前声明')
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
  assert.doesNotMatch(workflow, /bundled-sandbox-runtime|sandbox-image\.tar\.gz|Download bundled sandbox runtime/,
    '发布流水线不得把 Sandbox bundle 注入一体化 app')

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

  const manifestStep = publishJob.split('- name: Generate update manifest')[1]?.split('\n      - name:')[0] ?? ''
  assert.match(manifestStep, /BACKEND_DIGEST:\s*\$\{\{\s*steps\.digests\.outputs\.hub_backend\s*\}\}/,
    '生成更新清单必须注入 Docker Hub backend digest')
  assert.match(manifestStep, /FRONTEND_DIGEST:\s*\$\{\{\s*steps\.digests\.outputs\.hub_frontend\s*\}\}/,
    '生成更新清单必须注入 Docker Hub frontend digest')
})
