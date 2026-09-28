import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowPath = new URL('../../.github/workflows/docker-release.yml', import.meta.url)
const composePath = new URL('../../docker-compose.yml', import.meta.url)
const offlineComposePath = new URL('../../docker-compose.offline.yml', import.meta.url)
const productionComposePath = new URL('../../docker-compose.prod.yml', import.meta.url)
const appDockerfilePath = new URL('../../Dockerfile', import.meta.url)

test('默认和离线 Compose 使用内置沙箱，生产分体 Compose 只连接外部 Rootless manager', async () => {
  const [compose, offlineCompose, productionCompose, dockerfile] = await Promise.all([
    readFile(composePath, 'utf8'),
    readFile(offlineComposePath, 'utf8'),
    readFile(productionComposePath, 'utf8'),
    readFile(appDockerfilePath, 'utf8'),
  ])
  assert.match(compose, /GUGU_SANDBOX_MANAGER_MODE: embedded/)
  assert.match(compose, /DOCKER_HOST: unix:\/\/\/var\/run\/docker\.sock/)
  const appService = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  updater:'))
  assert.match(appService, /\$\{GUGU_DOCKER_SOCKET:-\/var\/run\/docker\.sock\}:\/var\/run\/docker\.sock/,
    '一体化 app 应显式访问宿主 daemon，供镜像内 manager 使用')
  assert.doesNotMatch(compose, /^  (?:sandboxd|egress-proxy):/m,
    '默认 Compose 不得拥有 sandboxd 或 egress-proxy 生命周期')
  assert.doesNotMatch(compose, /SANDBOX__IMAGE: \$\{GUGU_SANDBOX_IMAGE/,
    '一体化执行镜像应从 app 内置 bundle 加载，而非单独引用外部镜像')

  assert.doesNotMatch(offlineCompose, /^  (?:sandboxd|egress-proxy):/m,
    '离线覆盖层不应再定义独立 sandboxd/egress 服务')
  assert.doesNotMatch(offlineCompose, /GUGU_SANDBOX_BUNDLE_MANIFEST|GUGU_SANDBOX_OFFLINE/,
    '离线 Compose 应使用 app 镜像内的 bundle，不挂载第二份 manifest')

  assert.doesNotMatch(productionCompose, /^  (?:sandboxd|egress-proxy):/m,
    '生产分体 Compose 不得管理外部 sandbox manager 或 egress proxy')
  assert.equal((productionCompose.match(/GUGU_SANDBOX_MANAGER_MODE: external/g) ?? []).length, 2,
    'backend 与 worker 必须显式使用 external manager')
  assert.equal((productionCompose.match(/SANDBOX__ROOTLESS_REQUIRED: "true"/g) ?? []).length, 2,
    'backend 与 worker 必须继续强制 Rootless')
  assert.match(productionCompose, /sandbox_socket:\n\s+external: true\n\s+name: \$\{GUGU_SANDBOX_SOCKET_VOLUME:-gugu-web-compose_sandbox_socket\}/,
    '分体服务只能连接由外部 manager 管理的 socket volume')
  const backendService = productionCompose.slice(productionCompose.indexOf('\n  backend:'), productionCompose.indexOf('\n  updater:'))
  const workerService = productionCompose.slice(productionCompose.indexOf('\n  worker:'), productionCompose.indexOf('\n  gateway:'))
  assert.doesNotMatch(`${backendService}\n${workerService}`, /docker\.sock|DOCKER_HOST/,
    'backend/worker 不得获得 Docker Socket')

  assert.doesNotMatch(dockerfile, /docker\/sandbox\/bundle|\/opt\/gugu\/sandbox\//,
    'app 基础镜像仍不包含 bundle；它由候选组装层单独追加')
})

test('正式发布的离线 Compose bundle 不重复携带 app 内置沙箱镜像', async () => {
  const workflow = await readFile(workflowPath, 'utf8')
  const offlineJob = workflow.slice(workflow.indexOf('\n  offline-bundle:'))
  assert.match(offlineJob, /build-offline-sandbox-bundle\.sh/)
  assert.match(offlineJob, /--image coffeiz\/gugu-web:latest/)
  assert.match(offlineJob, /--image searxng\/searxng:latest/)
  assert.doesNotMatch(offlineJob, /gugu-sandbox:latest|ubuntu\/squid|sandbox-bundle-manifest\.json/)
  assert.match(offlineJob, /actions\/upload-artifact@v4/)
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
  const dockerBuildJob = workflow.slice(
    workflow.indexOf('\n  docker-build:\n'),
    workflow.indexOf('\n  assemble-candidate:\n'),
  )

  // 发布不再重建镜像：业务镜像从本轮 CI tag 复制，app 则必须来自已验证候选 digest。
  assert.match(publishJob, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/,
    '只有版本 tag 发布可创建正式 tag/Release；手动候选运行不得发布')
  assert.match(publishJob, /CI_SUFFIX: ci-\$\{\{\s*github\.run_id\s*\}\}/)
  assert.match(publishJob, /needs: \[compose-validate, sandbox-build, docker-build, assemble-candidate\]/,
    '正式发布必须等待 bundled app 候选组装与验证完成')
  assert.match(publishJob, /APP_CANDIDATE_DIGEST: \$\{\{\s*needs\.assemble-candidate\.outputs\.image_digest\s*\}\}/,
    '正式发布必须消费候选组装 job 输出的不可变 digest')
  const copyLines = publishJob.split('\n').filter(line => line.trim().startsWith('crane copy '))
  assert.equal(copyLines.length, 8, 'backend、frontend、app、sandbox 各复制到 GHCR 与 Docker Hub 共八次')
  // 版本 tag 全部使用发布版本号变量，Git SHA 不允许进入任何 tag。
  assert.ok(copyLines.every(line => line.includes(':${VERSION}') && !line.includes('github.sha')),
    '发布 tag 必须来自版本号变量')
  const appCopyLines = copyLines.filter(line => line.includes('${APP_CANDIDATE_DIGEST}'))
  assert.equal(appCopyLines.length, 2, 'app 候选应分别复制到 GHCR 与 Docker Hub')
  assert.ok(appCopyLines.every(line => line.includes('${IMAGE_REPOSITORY}@${APP_CANDIDATE_DIGEST}') && !line.includes('${CI_SUFFIX}')),
    '两个 registry 的 app 发布 tag 必须由已验证候选 digest 复制')
  assert.ok(copyLines.filter(line => line.includes('gugu-web-backend') || line.includes('gugu-web-frontend') || line.includes('gugu-sandbox'))
    .every(line => line.includes('${CI_SUFFIX}')),
  'backend、frontend 和 sandbox 继续复制本轮已扫描的 CI 镜像')
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
  assert.match(dockerBuildJob, /push: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| \(github\.event_name == 'workflow_dispatch' && matrix\.name == 'app'\) \}\}/,
    'tag 构建推送发布候选；手动候选只额外推送 app 基础镜像')
  assert.match(workflow, /assemble-candidate:/,
    '候选组装必须独立等待 app 与 bundle 两条流水线完成')
  assert.doesNotMatch(publishJob, /\$\{IMAGE_REPOSITORY\}:\$\{CI_SUFFIX\}/,
    '正式发布不得退回未打包的 app 基础镜像')

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
  assert.match(manifestStep, /APP_DIGEST:\s*\$\{\{\s*steps\.digests\.outputs\.hub_app\s*\}\}/,
    '更新清单必须使用从候选 app 正式 tag 解析的 Docker Hub digest')
})
