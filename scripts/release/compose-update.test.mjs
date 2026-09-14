import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const releaseDir = path.dirname(fileURLToPath(import.meta.url))
const sourceScript = path.join(releaseDir, 'compose-update.sh')
const sourceValidator = path.join(releaseDir, 'validate-update-manifest.mjs')
const appImage = `docker.io/coffeiz/gugu-web@sha256:${'a'.repeat(64)}`
const updaterDigest = `docker.io/coffeiz/gugu-web-updater@sha256:${'b'.repeat(64)}`

const dockerMock = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [[ "$1" == image && "$2" == inspect ]]; then
  printf '%s\\n' 'coffeiz/gugu-web-updater@sha256:${'b'.repeat(64)}'
  exit 0
fi
[[ "$1" == compose ]] || exit 90
shift
while (($#)); do
  case "$1" in
    -f|--profile) shift 2 ;;
    *) break ;;
  esac
done
command_name="$1"
shift
case "$command_name" in
  config)
    case "$1" in
      --services)
        if [[ "\${MOCK_SPLIT:-false}" == true ]]; then
          printf '%s\\n' postgres backend worker gateway frontend migrate data-migrate
        else
          printf '%s\\n' postgres redis searxng data-migrate app sandboxd
          if [[ "\${MOCK_UPDATER_SERVICE:-false}" == true ]]; then printf '%s\\n' updater; fi
        fi
        ;;
      --images) printf '%s\\n' postgres:18 redis:latest coffeiz/gugu-web:old ;;
      --format)
        image="$GUGU_WEB_IMAGE"
        if printenv GUGU_SANDBOXD_IMAGE >/dev/null 2>&1; then image="$GUGU_SANDBOXD_IMAGE"; fi
        updater_image="\${MOCK_UPDATER_IMAGE:-docker.io/coffeiz/gugu-web-updater:1.2.2}"
        printf '{"services":{"sandboxd":{"image":"%s"},"updater":{"image":"%s"}}}\\n' "$image" "$updater_image"
        ;;
      *) exit 91 ;;
    esac
    ;;
  ps)
    if [[ "\${MOCK_SANDBOXD_RUNNING:-true}" == true ]]; then
      printf '%s\\n' postgres app sandboxd
    else
      printf '%s\\n' postgres app
    fi
    ;;
  exec)
    [[ "$1" == -T ]] && shift
    service="$1"
    shift
    if [[ "$service" == postgres ]]; then printf 'fake database dump\\n'; fi
    ;;
  *) ;;
esac
`

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-compose-update-test-'))
  const scriptsDir = path.join(root, 'scripts', 'release')
  const binDir = path.join(root, 'mock-bin')
  fs.mkdirSync(scriptsDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true })
  fs.copyFileSync(sourceScript, path.join(scriptsDir, 'compose-update.sh'))
  fs.copyFileSync(sourceValidator, path.join(scriptsDir, 'validate-update-manifest.mjs'))
  fs.writeFileSync(path.join(root, 'backend', '.env'), 'ADMIN_PASSWORD=test-only-value\n')
  fs.writeFileSync(path.join(root, '.env'), 'GUGU_DB_PASSWORD=test-only-value\n')
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services: {}\n')
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schema_version: 2,
    version: 'v1.2.2',
    channel: 'stable',
    minimum_version: 'v1.2.1',
    app_image: appImage,
    architectures: ['linux/amd64'],
    database_migration: true,
    release_notes_url: 'https://github.com/Coffeiz/Gugu-web/releases/tag/v1.2.2',
    rollback_supported: true,
  }))
  fs.writeFileSync(path.join(root, 'manifest.bundle'), 'test-only-signature-bundle\n')
  const dockerPath = path.join(binDir, 'docker')
  fs.writeFileSync(dockerPath, dockerMock, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'cosign'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$MOCK_COSIGN_LOG"\nif [[ "${MOCK_COSIGN_FAIL:-false}" == true ]]; then exit 3; fi\nif [[ "${MOCK_COSIGN_FAIL_UPDATER:-false}" == true && "$*" == *gugu-web-updater@* ]]; then exit 4; fi\nif [[ "${MOCK_COSIGN_FAIL_OCI11:-false}" == true && "$*" == *--experimental-oci11* && "$*" != *--new-bundle-format=false* ]]; then exit 5; fi\nexit 0\n', { mode: 0o755 })
  return {
    root,
    binDir,
    dockerLog: path.join(root, 'docker.log'),
    cosignLog: path.join(root, 'cosign.log'),
  }
}

function runUpdate(
  fixture,
  extraEnv = {},
  scriptPath = path.join(fixture.root, 'scripts', 'release', 'compose-update.sh'),
  extraArgs = [],
) {
  return spawnSync('bash', [
    scriptPath,
    ...extraArgs,
    '--manifest', path.join(fixture.root, 'manifest.json'),
    '--bundle', path.join(fixture.root, 'manifest.bundle'),
    '--confirm',
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      MOCK_DOCKER_LOG: fixture.dockerLog,
      MOCK_COSIGN_LOG: fixture.cosignLog,
      GUGU_DB_PASSWORD: 'test-only-value',
      BACKUP_ROOT: path.join(fixture.root, 'backup'),
      ...extraEnv,
    },
  })
}

test('更新器从独立代码目录运行时仍使用部署目录和固定校验器', () => {
  const fixture = createFixture()
  const updaterCode = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-updater-code-'))
  const updaterScript = path.join(updaterCode, 'scripts', 'release', 'compose-update.sh')
  fs.mkdirSync(path.dirname(updaterScript), { recursive: true })
  fs.copyFileSync(sourceScript, updaterScript)
  fs.copyFileSync(sourceValidator, path.join(updaterCode, 'scripts', 'release', 'validate-update-manifest.mjs'))
  try {
    const result = runUpdate(fixture, {
      COMPOSE_PROJECT_DIR: fixture.root,
      COMPOSE_FILE: path.join(fixture.root, 'docker-compose.yml'),
      UPDATE_VALIDATOR: path.join(updaterCode, 'scripts', 'release', 'validate-update-manifest.mjs'),
    }, updaterScript)
    assert.equal(result.status, 0, result.stderr)
    assert.match(fs.readFileSync(fixture.dockerLog, 'utf8'), /pull app data-migrate sandboxd/)
    const backupRoot = path.join(fixture.root, 'backup')
    assert.equal(fs.readdirSync(backupRoot).length, 1)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
    fs.rmSync(updaterCode, { recursive: true, force: true })
  }
})

test('只更新一体化 app，并在同镜像 sandboxd 运行时同步更新', () => {
  const fixture = createFixture()
  try {
    const result = runUpdate(fixture)
    assert.equal(result.status, 0, result.stderr)
    const cosignCalls = fs.readFileSync(fixture.cosignLog, 'utf8').trim().split('\n')
    assert.ok(cosignCalls.some(call => call.startsWith('verify-blob --bundle ')))
    assert.ok(cosignCalls.some(call => call.startsWith('verify --experimental-oci11 ') && call.endsWith(appImage)))
    const log = fs.readFileSync(fixture.dockerLog, 'utf8')
    assert.match(log, /pull app data-migrate sandboxd/)
    assert.match(log, /up -d --no-deps --force-recreate app sandboxd/)
    assert.doesNotMatch(log, /gugu-web-(?:backend|frontend)/)

    const backupRoot = path.join(fixture.root, 'backup')
    const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot)[0])
    assert.match(fs.readFileSync(path.join(backupDir, 'previous-images.txt'), 'utf8'), /coffeiz\/gugu-web:old/)
    assert.equal(fs.readFileSync(path.join(backupDir, 'compose.env'), 'utf8'), 'GUGU_DB_PASSWORD=test-only-value\n')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('未运行 sandboxd 时不拉取或重建可选沙盒服务', () => {
  const fixture = createFixture()
  try {
    const result = runUpdate(fixture, { MOCK_SANDBOXD_RUNNING: 'false' })
    assert.equal(result.status, 0, result.stderr)
    const log = fs.readFileSync(fixture.dockerLog, 'utf8')
    assert.match(log, /pull app data-migrate\n/)
    assert.match(log, /up -d --no-deps --force-recreate app\n/)
    assert.doesNotMatch(log, /pull app data-migrate sandboxd/)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('手动升级验证 manifest、业务镜像和 updater 签名后引导 sidecar，sidecar 自身可跳过', () => {
  const fixture = createFixture()
  try {
    const bootstrap = runUpdate(fixture, { MOCK_UPDATER_SERVICE: 'true' })
    assert.equal(bootstrap.status, 0, bootstrap.stderr)
    let log = fs.readFileSync(fixture.dockerLog, 'utf8')
    const updaterPullIndex = log.indexOf('pull updater')
    const appPullIndex = log.indexOf('pull app data-migrate')
    assert.ok(updaterPullIndex >= 0)
    assert.ok(appPullIndex > updaterPullIndex)
    assert.match(log, /image inspect --format/)
    assert.match(log, /up -d --no-deps updater/)
    const cosignCalls = fs.readFileSync(fixture.cosignLog, 'utf8').trim().split('\n')
    assert.ok(cosignCalls.some(call => call.startsWith('verify --experimental-oci11 ') && call.endsWith(updaterDigest)))

    fs.writeFileSync(fixture.dockerLog, '')
    fs.writeFileSync(fixture.cosignLog, '')
    const sidecarRun = runUpdate(fixture, {
      MOCK_UPDATER_SERVICE: 'true',
      COMPOSE_PROJECT_DIR: fixture.root,
      UPDATE_VALIDATOR: path.join(fixture.root, 'scripts', 'release', 'validate-update-manifest.mjs'),
    }, path.join(fixture.root, 'scripts', 'release', 'compose-update.sh'), ['--skip-updater-bootstrap'])
    assert.equal(sidecarRun.status, 0, sidecarRun.stderr)
    log = fs.readFileSync(fixture.dockerLog, 'utf8')
    assert.doesNotMatch(log, /up -d --no-deps updater/)
    assert.doesNotMatch(log, /pull updater/)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('新式 referrer 验签失败时回退验证已有的旧式签名 tag', () => {
  const fixture = createFixture()
  try {
    const result = runUpdate(fixture, { MOCK_COSIGN_FAIL_OCI11: 'true' })
    assert.equal(result.status, 0, result.stderr)
    const calls = fs.readFileSync(fixture.cosignLog, 'utf8').trim().split('\n')
    assert.ok(calls.some(call => call.startsWith('verify --experimental-oci11 ') && call.endsWith(appImage)))
    assert.ok(calls.some(call => call.startsWith('verify --experimental-oci11 --new-bundle-format=false ') && call.endsWith(appImage)))
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('目标 manifest 签名失败时不得引导安装 updater', () => {
  const fixture = createFixture()
  try {
    const result = runUpdate(fixture, {
      MOCK_UPDATER_SERVICE: 'true',
      MOCK_COSIGN_FAIL: 'true',
    })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(fs.readFileSync(fixture.dockerLog, 'utf8'), /pull updater|up -d --no-deps updater/)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('updater digest 签名失败时不得启动 sidecar', () => {
  const fixture = createFixture()
  try {
    const result = runUpdate(fixture, {
      MOCK_UPDATER_SERVICE: 'true',
      MOCK_COSIGN_FAIL_UPDATER: 'true',
    })
    assert.notEqual(result.status, 0)
    const log = fs.readFileSync(fixture.dockerLog, 'utf8')
    assert.match(log, /pull updater/)
    assert.doesNotMatch(log, /up -d --no-deps updater/)
    assert.ok(fs.readFileSync(fixture.cosignLog, 'utf8').includes(updaterDigest))
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('拒绝非官方 updater 镜像来源', () => {
  const fixture = createFixture()
  try {
    const result = runUpdate(fixture, {
      MOCK_UPDATER_SERVICE: 'true',
      MOCK_UPDATER_IMAGE: 'attacker.invalid/updater:latest',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /updater 镜像不在官方发布白名单内/)
    assert.doesNotMatch(fs.readFileSync(fixture.dockerLog, 'utf8'), /pull updater/)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('拒绝拆分 backend/frontend Compose，不进入更新流程', () => {
  const fixture = createFixture()
  try {
    const result = runUpdate(fixture, { MOCK_SPLIT: 'true' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /不支持一体化更新/)
    assert.doesNotMatch(fs.readFileSync(fixture.dockerLog, 'utf8'), /pull /)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})
