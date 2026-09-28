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

test('Sandbox 从当前提交构建、扫描后就地打包并记录提交身份', async () => {
  const [workflow, bundleAction] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(bundleActionPath, 'utf8'),
  ])
  const normalizedWorkflow = workflow.replace(/\r\n/g, '\n')
  const sandboxJob = normalizedWorkflow.slice(normalizedWorkflow.indexOf('\n  sandbox-build:'), normalizedWorkflow.indexOf('\n  docker-build:'))
  const appJob = normalizedWorkflow.slice(normalizedWorkflow.indexOf('\n  docker-build:'), normalizedWorkflow.indexOf('\n  publish:'))

  assert.match(sandboxJob, /Smoke test sandbox runtime[\s\S]*Scan sandbox image[\s\S]*Package same-commit embedded runtime bundle/)
  assert.match(sandboxJob, /docker image inspect --format '\{\{\.Id\}\}'/)
  assert.match(bundleAction, /inputs\.sandbox-image-id/)
  assert.match(bundleAction, /crane digest --platform linux\/amd64 ubuntu\/squid:latest/,
    'egress proxy digest 必须解析成与执行镜像相同平台的不可变子 manifest')
  assert.match(bundleAction, /FROM ubuntu\/squid@%s[\s\S]*type=docker,dest=\$\{proxy_archive\}[\s\S]*docker load --input/,
    '固定 digest 必须通过 BuildKit 直接导出完整 Docker archive，再导入目标 daemon')
  assert.match(bundleAction, /docker image tag "\$SANDBOX_ID" gugu-sandbox:embedded/,
    'bundle 应按通过 smoke/scan 的 sandbox image ID 打 tag')
  assert.match(bundleAction, /docker image inspect --format '\{\{\.Id\}\}' gugu-egress-proxy:embedded/,
    'bundle 应从通过固定 digest 导入的镜像取得 image ID')
  assert.match(bundleAction, /--sandbox-digest "\$SANDBOX_ID"/)
  assert.match(bundleAction, /--source-revision "\$SOURCE_REVISION"/)
  assert.match(bundleAction, /Scan immutable egress proxy image[\s\S]*Build embedded runtime bundle/)
  assert.match(bundleAction, /--egress-proxy-digest "\$EGRESS_PROXY_ID"/)
  assert.match(bundleAction, /Upload embedded runtime bundle[\s\S]*actions\/upload-artifact@v4/)
  assert.ok(bundleAction.indexOf('Scan immutable egress proxy image') < bundleAction.indexOf('Build embedded runtime bundle'))
  assert.ok(bundleAction.indexOf('Build embedded runtime bundle') < bundleAction.indexOf('Upload embedded runtime bundle'))
  assert.match(appJob, /needs: \[compose-validate, sandbox-build\]/)
})

test('候选 app 在同一源码提交上组装、校验、扫描后才推 tag 临时引用', async () => {
  const [workflow, candidateAction, verifier] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(candidateActionPath, 'utf8'),
    readFile(verifierPath, 'utf8'),
  ])
  const normalizedWorkflow = workflow.replace(/\r\n/g, '\n')
  const appJob = normalizedWorkflow.slice(normalizedWorkflow.indexOf('\n  docker-build:'), normalizedWorkflow.indexOf('\n  publish:'))

  assert.match(appJob, /uses: \.\/\.github\/actions\/assemble-embedded-app-candidate/)
  assert.match(appJob, /source-revision: \$\{\{ github\.sha \}\}/)
  assert.match(appJob, /Scan \$\{\{ matrix\.name \}\} image[\s\S]*steps\.candidate\.outputs\.ref/)
  assert.match(appJob, /Scan \$\{\{ matrix\.name \}\} image[\s\S]*Push verified bundled app candidate/)
  assert.ok(appJob.indexOf('Scan ${{ matrix.name }} image') < appJob.indexOf('Push verified bundled app candidate'),
    '候选必须完成安全扫描后才推送临时 tag')
  assert.match(appJob, /crane manifest --platform linux\/amd64/)
  assert.match(candidateAction, /docker build --platform linux\/amd64[\s\S]*release\/embedded-bundle/)
  assert.match(candidateAction, /--build-arg "APP_IMAGE=\$BASE_IMAGE"/)
  assert.match(candidateAction, /verify_embedded_app_image\.py[\s\S]*--expected-source-revision/)
  assert.match(verifier, /"--network", "none"/)
})

test('正式 tag 发布只消费已验证的 bundled app，并继续发布独立分体 Sandbox', async () => {
  const workflow = (await readFile(workflowPath, 'utf8')).replace(/\r\n/g, '\n')
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:\n'))

  assert.match(publishJob, /BUNDLED_APP_SUFFIX: bundled-ci-\$\{\{ github\.run_id \}\}/,
    '正式发布必须读取同次构建的已验证候选 app')
  assert.equal(
    publishJob.split('\n').filter(line => line.includes('crane copy') && line.includes('BUNDLED_APP_SUFFIX')).length,
    2,
    'GHCR 与 Docker Hub 的 app tag 均必须从同一个 bundled candidate 复制',
  )
  assert.match(publishJob, /crane copy "\$\{REGISTRY\}\/coffeiz\/gugu-sandbox:\$\{CI_SUFFIX\}"/,
    '分体部署的独立 Sandbox 版本仍须发布')
  assert.doesNotMatch(publishJob, /crane copy "\$\{REGISTRY\}\/coffeiz\/gugu-web:\$\{CI_SUFFIX\}"/,
    '不得将未打包的 CI app 基础镜像发布为正式版本')
})
