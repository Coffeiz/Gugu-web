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

const dockerMock = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [[ "$1" == inspect ]]; then
  if [[ "$*" == *'/var/run/docker.sock'* ]]; then
    printf '%s\\n' "\${MOCK_SOCKET_SOURCE:-/tmp/docker.sock}"
  else
    printf '%s\\n' "\${MOCK_DATA_SOURCE:-/tmp}"
  fi
  exit 0
fi
if [[ "$1" == run ]]; then
  exit 0
fi
if [[ "$1" == image && "$2" == inspect ]]; then
  printf '%s\\n' 'coffeiz/gugu-web@sha256:${'b'.repeat(64)}'
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
          printf '%s\\n' postgres backend worker gateway frontend migrate
        else
          printf '%s\\n' postgres redis searxng app sandboxd
          if [[ "\${MOCK_UPDATER_SERVICE:-false}" == true ]]; then printf '%s\\n' updater; fi
        fi
        ;;
      --images) printf '%s\\n' postgres:18 redis:latest coffeiz/gugu-web:old ;;
      --format)
        image="$GUGU_WEB_IMAGE"
        if printenv GUGU_SANDBOXD_IMAGE >/dev/null 2>&1; then image="$GUGU_SANDBOXD_IMAGE"; fi
        updater_image="\${MOCK_UPDATER_IMAGE:-docker.io/coffeiz/gugu-web:1.2.2}"
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
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
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
  const dockerPath = path.join(binDir, 'docker')
  fs.writeFileSync(dockerPath, dockerMock, { mode: 0o755 })
  return {
    root,
    binDir,
    dockerLog: path.join(root, 'docker.log'),
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
    '--confirm',
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      MOCK_DOCKER_LOG: fixture.dockerLog,
      // 模拟只能在宿主 namespace 访问的路径，验证脚本不会在 app 容器内检查它们。
      MOCK_DATA_SOURCE: '/host-only/gugu-data',
      MOCK_SOCKET_SOURCE: '/run/user/1000/docker.sock',
      GUGU_DB_PASSWORD: 'test-only-value',
      BACKUP_ROOT: path.join(fixture.root, 'backup'),
      ...extraEnv,
    },
  })
}

test('app 更新会把 stop/recreate 交给独立 helper，避免 self-stop 截断脚本', () => {
  const fixture = createFixture()
  try {
    const result = runUpdate(fixture, { GUGU_UPDATE_HELPER_IMAGE: appImage })
    assert.equal(result.status, 75, result.stderr)
    const log = fs.readFileSync(fixture.dockerLog, 'utf8')
    assert.match(log, /run .*--label com\.coffeiz\.gugu\.update-helper=true/)
    assert.match(log, /--entrypoint \/bin\/bash/)
    assert.match(log, /--env GUGU_DB_PASSWORD/)
    assert.match(log, /--env GUGU_DB_USER/)
    assert.match(log, /--env GUGU_DB_NAME/)
    assert.match(log, /source=\/run\/user\/1000\/docker\.sock,target=\/var\/run\/docker\.sock/)
    assert.doesNotMatch(log, /compose stop app/)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('独立 helper 只在旧 app 持久化 handoff 后继续更新', () => {
  const fixture = createFixture()
  const manifestPath = path.join(fixture.root, 'manifest.json')
  fs.writeFileSync(`${manifestPath}.handoff`, 'ready\n')
  try {
    const result = runUpdate(fixture, {
      GUGU_UPDATE_HELPER: '1',
      GUGU_UPDATE_WAIT_FOR_HANDOFF_FILE: `${manifestPath}.handoff`,
    })
    assert.equal(result.status, 0, result.stderr)
    const log = fs.readFileSync(fixture.dockerLog, 'utf8')
    assert.match(log, /compose .* stop app/)
    assert.doesNotMatch(log, /docker run/)
    assert.equal(fs.existsSync(`${manifestPath}.handoff`), false)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

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
    assert.match(fs.readFileSync(fixture.dockerLog, 'utf8'), /pull app sandboxd/)
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
    const log = fs.readFileSync(fixture.dockerLog, 'utf8')
    assert.match(log, /pull app sandboxd/)
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
    assert.match(log, /pull app\n/)
    assert.match(log, /up -d --no-deps --force-recreate app\n/)
    assert.doesNotMatch(log, /pull app sandboxd/)
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
