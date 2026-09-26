import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const releaseDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(releaseDir, '../..')
const integrationEnabled = process.env.GUGU_RUN_DOCKER_INTEGRATION === '1'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  return result
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`)
}

function compose(root, project, ...args) {
  return run('docker', ['compose', '-p', project, '-f', path.join(root, 'compose.yml'), ...args], { cwd: root })
}

function imageOf(containerId) {
  const result = run('docker', ['inspect', '--format', '{{.Config.Image}}', containerId])
  requireSuccess(result, '读取测试容器镜像失败')
  return result.stdout.trim()
}

function writeFixture(root, id) {
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true })
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'fixture', 'updater'), { recursive: true })
  fs.writeFileSync(path.join(root, 'backend', '.env'), 'ADMIN_PASSWORD=synthetic-integration-secret\nSYNTHETIC_CONFIG=preserve-me\n', { mode: 0o600 })
  fs.writeFileSync(path.join(root, 'fixture', 'updater', '__init__.py'), '')
  fs.writeFileSync(path.join(root, 'fixture', 'updater', 'database_check.py'), 'print("synthetic migration check passed")\n')
  for (const module of ['standalone.py', 'standalone_helper.py']) {
    fs.copyFileSync(path.join(repositoryRoot, 'backend', 'updater', module), path.join(root, 'fixture', 'updater', module))
  }
  fs.writeFileSync(path.join(root, 'fixture', 'curl'), '#!/bin/sh\n[ "$(cat /etc/e2e-health-mode)" = fail ] && exit 22\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'fixture', 'pg_dumpall'), '#!/bin/sh\nprintf "%s\\n" "-- PostgreSQL database cluster dump" "synthetic database"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'fixture', 'docker'), `#!/usr/bin/env python3
import http.client
import json
import socket
import sys

class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')

def request(method, path, payload=None):
    connection = UnixHTTPConnection('docker', timeout=30)
    body = json.dumps(payload, separators=(',', ':')).encode() if payload is not None else None
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    result = response.read()
    status = response.status
    connection.close()
    return status, result

def main():
    if len(sys.argv) < 4 or sys.argv[1] != 'exec':
        raise SystemExit(2)
    container, command = sys.argv[2], sys.argv[3:]
    try:
            status, result = request('POST', f'/containers/{container}/exec', {
            'Cmd': command, 'AttachStdin': False, 'AttachStdout': True, 'AttachStderr': True,
        })
    except Exception as exc:
        print(f'fixture docker exec create failed: {type(exc).__name__}: {exc}', file=sys.stderr)
        raise SystemExit(1)
    if status != 201:
        print(f'fixture docker exec create returned HTTP {status}: {result[:512]!r}', file=sys.stderr)
        raise SystemExit(1)
    exec_id = json.loads(result)['Id']
    status, stream = request('POST', f'/exec/{exec_id}/start', {'Detach': False, 'Tty': False})
    if status not in (200, 201):
        print(f'fixture docker exec start returned HTTP {status}: {stream[:512]!r}', file=sys.stderr)
        raise SystemExit(1)
    offset = 0
    while offset + 8 <= len(stream):
        stream_type = stream[offset]
        size = int.from_bytes(stream[offset + 4:offset + 8], 'big')
        offset += 8
        frame = stream[offset:offset + size]
        offset += size
        target = sys.stdout.buffer if stream_type == 1 else sys.stderr.buffer
        target.write(frame)
        target.flush()
    inspect_status, inspect = request('GET', f'/exec/{exec_id}/json')
    if inspect_status != 200 or json.loads(inspect).get('ExitCode') != 0:
        print(f'fixture docker exec finished unsuccessfully: HTTP {inspect_status}, {inspect[:512]!r}', file=sys.stderr)
        raise SystemExit(1)

if __name__ == '__main__':
    main()
`, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'Dockerfile'), `FROM python:3.14-slim-bookworm\nARG HEALTH_MODE=ok\nENV PYTHONPATH=/opt/e2e\nCOPY fixture/updater /opt/e2e/updater\nCOPY fixture/curl /usr/local/bin/curl\nCOPY fixture/pg_dumpall /usr/local/bin/pg_dumpall\nCOPY fixture/docker /usr/local/bin/docker\nRUN printf '%s' "$HEALTH_MODE" > /etc/e2e-health-mode && chmod 755 /usr/local/bin/curl /usr/local/bin/pg_dumpall /usr/local/bin/docker\nCMD ["python", "-c", "import time; time.sleep(86400)"]\n`)
  fs.writeFileSync(path.join(root, 'compose.yml'), `name: ${id}\nservices:\n  postgres:\n    image: postgres:18-alpine\n    environment: { POSTGRES_USER: e2e, POSTGRES_PASSWORD: synthetic, POSTGRES_DB: e2e }\n    volumes: [pgdata:/var/lib/postgresql]\n    healthcheck:\n      test: [CMD-SHELL, pg_isready -U e2e -d e2e]\n      interval: 2s\n      timeout: 2s\n      retries: 30\n  redis:\n    image: redis:7-alpine\n    volumes: [redisdata:/data]\n  migrate:\n    image: docker.io/coffeiz/gugu-web-backend:${id}-old\n  backend:\n    image: docker.io/coffeiz/gugu-web-backend:${id}-old\n    volumes: [appdata:/data]\n  worker:\n    image: docker.io/coffeiz/gugu-web-backend:${id}-old\n  gateway:\n    image: docker.io/coffeiz/gugu-web-backend:${id}-old\n  frontend:\n    image: docker.io/coffeiz/gugu-web-frontend:${id}-old\n  nginx:\n    image: docker.io/coffeiz/gugu-web-frontend:${id}-old\nvolumes:\n  pgdata:\n  redisdata:\n  appdata:\n`)

  const dockerPath = run('sh', ['-lc', 'command -v docker']).stdout.trim()
  assert.ok(dockerPath, 'devserver 未找到 Docker CLI')
  const dockerShim = `#!/bin/bash\nset -euo pipefail\nif [[ "\${1:-}" == compose ]]; then\n  shift\n  args=("$@")\n  command_name=""\n  for ((i=0; i<\${#args[@]}; i++)); do\n    if [[ "\${args[$i]}" == -f ]]; then\n      i=$((i+1))\n      file="\${args[$i]}"\n      if [[ "$file" == *.json && -f "$file" ]]; then\n        node -e 'const fs=require("node:fs");const f=process.argv[1];const v=JSON.parse(fs.readFileSync(f,"utf8"));for(const s of Object.values(v.services||{})){if(s.image?.endsWith("@sha256:"+"b".repeat(64)))s.image=process.env.E2E_BACKEND_IMAGE;if(s.image?.endsWith("@sha256:"+"c".repeat(64)))s.image=process.env.E2E_FRONTEND_IMAGE;}fs.writeFileSync(f,JSON.stringify(v));' "$file"\n      fi\n    fi\n    case "\${args[$i]}" in config|ps|exec|run|up|pull) command_name="\${args[$i]}"; break ;; esac\n  done\n  if [[ "$command_name" == pull ]]; then exit 0; fi\n  exec "$REAL_DOCKER" compose "\${args[@]}"\nfi\nexec "$REAL_DOCKER" "$@"\n`
  const unifiedAwareDockerShim = dockerShim.replace(
    '  if [[ "$command_name" == pull ]]; then exit 0; fi\n  exec "$REAL_DOCKER" compose',
    '  if [[ "$command_name" == pull ]]; then exit 0; fi\n  if [[ "${GUGU_WEB_IMAGE:-}" == *@sha256:* ]]; then export GUGU_WEB_IMAGE="$E2E_APP_IMAGE"; fi\n  exec "$REAL_DOCKER" compose',
  )
  fs.writeFileSync(path.join(root, 'bin', 'docker'), unifiedAwareDockerShim, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'bin', 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const backendOld = `docker.io/coffeiz/gugu-web-backend:${id}-old`
  const backendNew = `docker.io/coffeiz/gugu-web-backend:${id}-new`
  const backendFail = `docker.io/coffeiz/gugu-web-backend:${id}-fail`
  const frontendOld = `docker.io/coffeiz/gugu-web-frontend:${id}-old`
  const frontendNew = `docker.io/coffeiz/gugu-web-frontend:${id}-new`
  for (const [tag, healthMode] of [[backendOld, 'ok'], [backendNew, 'ok'], [backendFail, 'fail'], [frontendOld, 'ok'], [frontendNew, 'ok']]) {
    const build = run('docker', ['build', '--quiet', '--build-arg', `HEALTH_MODE=${healthMode}`, '-t', tag, root])
    requireSuccess(build, `构建隔离测试镜像失败：${tag}`)
  }
  return { backendOld, backendNew, backendFail, frontendOld, frontendNew }
}

function createManifest(root) {
  const manifestPath = path.join(root, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema_version: 3,
    version: 'v9.8.7',
    channel: 'stable',
    minimum_version: 'v9.8.6',
    app_image: `docker.io/coffeiz/gugu-web@sha256:${'a'.repeat(64)}`,
    split_images: {
      backend_image: `docker.io/coffeiz/gugu-web-backend@sha256:${'b'.repeat(64)}`,
      frontend_image: `docker.io/coffeiz/gugu-web-frontend@sha256:${'c'.repeat(64)}`,
    },
    architectures: ['linux/amd64'],
    database_migration: true,
    release_notes_url: 'https://github.com/Coffeiz/Gugu-web/releases/tag/v9.8.7',
    rollback_supported: true,
  }))
  return manifestPath
}

async function exerciseUpdate({ failHealth }) {
  const id = `gugu-update-e2e-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`))
  let images = []
  try {
    images = Object.values(writeFixture(root, id))
    const baseEnv = {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      REAL_DOCKER: run('sh', ['-lc', 'command -v docker']).stdout.trim(),
      COMPOSE_PROJECT_DIR: root,
      COMPOSE_FILE: path.join(root, 'compose.yml'),
      BACKUP_ROOT: path.join(root, 'backup'),
      UPDATE_VALIDATOR: path.join(releaseDir, 'validate-update-manifest.mjs'),
      UPDATE_SCHEMA: path.join(repositoryRoot, 'deploy/update-manifest.schema.json'),
      GUGU_DB_USER: 'e2e',
      GUGU_DB_NAME: 'e2e',
      E2E_BACKEND_IMAGE: failHealth ? images[2] : images[1],
      E2E_FRONTEND_IMAGE: images[4],
    }
    const startup = compose(root, id, 'up', '-d', '--wait', '--wait-timeout', '60', 'postgres', 'redis', 'backend', 'worker', 'gateway', 'frontend', 'nginx')
    if (startup.status !== 0) {
      const logs = compose(root, id, 'logs', '--no-color', 'postgres')
      throw new Error(`启动隔离 Compose 栈失败\n${startup.stdout}\n${startup.stderr}\nPostgreSQL 日志：\n${logs.stdout}\n${logs.stderr}`)
    }
    const postgresBefore = compose(root, id, 'ps', '-q', 'postgres').stdout.trim()
    const redisBefore = compose(root, id, 'ps', '-q', 'redis').stdout.trim()
    const backendBefore = compose(root, id, 'ps', '-q', 'backend').stdout.trim()
    const workerBefore = compose(root, id, 'ps', '-q', 'worker').stdout.trim()
    const gatewayBefore = compose(root, id, 'ps', '-q', 'gateway').stdout.trim()
    assert.ok(postgresBefore && redisBefore && backendBefore && workerBefore && gatewayBefore, '测试栈关键容器未启动')
    requireSuccess(compose(root, id, 'exec', '-T', 'postgres', 'psql', '-U', 'e2e', '-d', 'e2e', '-c', "CREATE TABLE update_probe (value text); INSERT INTO update_probe VALUES ('split-db-marker');"), '写入数据库持久化探针失败')
    requireSuccess(compose(root, id, 'exec', '-T', 'backend', 'sh', '-c', 'mkdir -p /data/byok && printf byok-marker > /data/byok/.byok-master-key && printf preserved-marker > /data/persistence-marker'), '写入数据卷探针失败')

    const update = run('bash', [path.join(releaseDir, 'split-compose-update.sh'), createManifest(root)], {
      cwd: root,
      encoding: 'utf8',
      env: baseEnv,
    })
    if (failHealth) {
      assert.equal(update.status, 76, `健康检查失败时应自动回滚\n${update.stdout}\n${update.stderr}`)
    } else {
      requireSuccess(update, '成功升级路径失败')
    }

    const backendAfter = compose(root, id, 'ps', '-q', 'backend').stdout.trim()
    const frontendAfter = compose(root, id, 'ps', '-q', 'frontend').stdout.trim()
    const workerAfter = compose(root, id, 'ps', '-q', 'worker').stdout.trim()
    const gatewayAfter = compose(root, id, 'ps', '-q', 'gateway').stdout.trim()
    assert.notEqual(backendAfter, backendBefore, 'backend 应已替换')
    assert.notEqual(workerAfter, workerBefore, 'worker 应按顺序重建')
    assert.notEqual(gatewayAfter, gatewayBefore, 'gateway 应按顺序重建')
    assert.notEqual(frontendAfter, '', 'frontend 应保持运行')
    assert.equal(compose(root, id, 'ps', '-q', 'postgres').stdout.trim(), postgresBefore, 'PostgreSQL 不应重建')
    assert.equal(compose(root, id, 'ps', '-q', 'redis').stdout.trim(), redisBefore, 'Redis 不应重建')

    const expectedBackend = failHealth ? images[0] : (process.env.E2E_BACKEND_IMAGE || images[1])
    const expectedFrontend = failHealth ? images[3] : images[4]
    assert.equal(imageOf(backendAfter), expectedBackend, 'backend 镜像应为目标版本或自动恢复的原版本')
    assert.equal(imageOf(workerAfter), expectedBackend, 'worker 应使用目标版本或自动恢复的原版本')
    assert.equal(imageOf(gatewayAfter), expectedBackend, 'gateway 应使用目标版本或自动恢复的原版本')
    assert.equal(imageOf(frontendAfter), expectedFrontend, 'frontend 应使用新镜像或在失败时恢复原镜像')
    for (const containerId of [backendAfter, workerAfter, gatewayAfter, frontendAfter]) {
      const mounts = JSON.parse(run('docker', ['inspect', '--format', '{{json .Mounts}}', containerId]).stdout)
      assert.equal(mounts.some((mount) => mount.Destination === '/var/run/docker.sock'), false, '分体业务容器不得挂 Docker socket')
    }
    const marker = compose(root, id, 'exec', '-T', 'backend', 'cat', '/data/persistence-marker')
    requireSuccess(marker, '验证持久卷标记失败')
    assert.equal(marker.stdout.trim(), 'preserved-marker')
    const byokMarker = compose(root, id, 'exec', '-T', 'backend', 'cat', '/data/byok/.byok-master-key')
    requireSuccess(byokMarker, '验证 BYOK 主密钥持久卷探针失败')
    assert.equal(byokMarker.stdout.trim(), 'byok-marker')
    const databaseMarker = compose(root, id, 'exec', '-T', 'postgres', 'psql', '-U', 'e2e', '-d', 'e2e', '-tAc', 'SELECT value FROM update_probe')
    requireSuccess(databaseMarker, '验证数据库升级前记录失败')
    assert.equal(databaseMarker.stdout.trim(), 'split-db-marker')

    const backupRoot = path.join(root, 'backup')
    const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot)[0])
    assert.equal(fs.readFileSync(path.join(backupDir, 'backend.env'), 'utf8'), 'ADMIN_PASSWORD=synthetic-integration-secret\nSYNTHETIC_CONFIG=preserve-me\n')
    const sqlBackup = fs.readFileSync(path.join(backupDir, 'postgres.sql'), 'utf8')
    assert.match(sqlBackup, /split-db-marker/, '数据库备份应包含升级前测试记录')
    assert.equal(fs.readFileSync(path.join(root, 'backend', '.env'), 'utf8'), 'ADMIN_PASSWORD=synthetic-integration-secret\nSYNTHETIC_CONFIG=preserve-me\n', '用户配置不得被更新流程改写')
  } finally {
    const down = compose(root, id, 'down', '-v', '--remove-orphans')
    if (down.status !== 0) process.stderr.write(`临时 Compose 清理失败（项目 ${id}）：${down.stderr}`)
    if (images.length) run('docker', ['image', 'rm', '-f', ...images])
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('隔离 Compose 栈完成分体升级并保留数据库、配置和数据卷', { skip: !integrationEnabled }, async () => {
  await exerciseUpdate({ failHealth: false })
})

test('隔离 Compose 栈健康检查失败后自动恢复旧 backend 且保留数据', { skip: !integrationEnabled }, async () => {
  await exerciseUpdate({ failHealth: true })
})

test('隔离 Compose 栈完成一体化 app 更新并保留数据库、配置与 BYOK 数据卷', { skip: !integrationEnabled }, () => {
  const id = `gugu-integrated-e2e-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`))
  const oldImage = `docker.io/coffeiz/gugu-web:${id}-old`
  const newImage = `docker.io/coffeiz/gugu-web:${id}-new`
  const imageTags = [oldImage, newImage]
  try {
    const built = writeFixture(root, id)
    imageTags.push(...Object.values(built))
    requireSuccess(run('docker', ['image', 'tag', built.backendOld, oldImage]), '标记一体化旧镜像失败')
    requireSuccess(run('docker', ['image', 'tag', built.backendNew, newImage]), '标记一体化新镜像失败')
    fs.writeFileSync(path.join(root, 'compose.yml'), `name: ${id}\nservices:\n  postgres:\n    image: postgres:18-alpine\n    environment: { POSTGRES_USER: e2e, POSTGRES_PASSWORD: synthetic, POSTGRES_DB: e2e }\n    volumes: [pgdata:/var/lib/postgresql]\n    healthcheck:\n      test: [CMD-SHELL, pg_isready -U e2e -d e2e]\n      interval: 2s\n      timeout: 2s\n      retries: 30\n  app:\n    image: \${GUGU_WEB_IMAGE:-${oldImage}}\n    volumes: [appdata:/data]\nvolumes:\n  pgdata:\n  appdata:\n`)
    const env = {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      REAL_DOCKER: run('sh', ['-lc', 'command -v docker']).stdout.trim(),
      COMPOSE_PROJECT_DIR: root,
      COMPOSE_FILE: path.join(root, 'compose.yml'),
      BACKUP_ROOT: path.join(root, 'backup'),
      UPDATE_VALIDATOR: path.join(releaseDir, 'validate-update-manifest.mjs'),
      UPDATE_SCHEMA: path.join(repositoryRoot, 'deploy/update-manifest.schema.json'),
      GUGU_DB_PASSWORD: 'synthetic',
      GUGU_DB_USER: 'e2e',
      GUGU_DB_NAME: 'e2e',
      GUGU_WEB_IMAGE: '',
      E2E_APP_IMAGE: newImage,
    }
    requireSuccess(run('docker', ['compose', '-p', id, '-f', path.join(root, 'compose.yml'), 'up', '-d', '--wait', '--wait-timeout', '60', 'postgres', 'app'], { cwd: root }), '启动一体化隔离 Compose 栈失败')
    const postgresBefore = compose(root, id, 'ps', '-q', 'postgres').stdout.trim()
    const appBefore = compose(root, id, 'ps', '-q', 'app').stdout.trim()
    requireSuccess(compose(root, id, 'exec', '-T', 'app', 'sh', '-c', 'mkdir -p /data/byok && printf byok-marker > /data/byok/.byok-master-key'), '写入一体化 BYOK 持久卷探针失败')

    const update = run('bash', [path.join(repositoryRoot, 'scripts/release/compose-update.sh'), '--manifest', createManifest(root), '--confirm'], { cwd: root, env })
    requireSuccess(update, `一体化 app 更新失败\n${update.stdout}\n${update.stderr}`)
    const appAfter = compose(root, id, 'ps', '-q', 'app').stdout.trim()
    assert.notEqual(appAfter, appBefore, '一体化 app 应已替换')
    assert.equal(compose(root, id, 'ps', '-q', 'postgres').stdout.trim(), postgresBefore, 'PostgreSQL 不应重建')
    assert.equal(imageOf(appAfter), newImage)
    const marker = compose(root, id, 'exec', '-T', 'app', 'cat', '/data/byok/.byok-master-key')
    requireSuccess(marker, '验证一体化 BYOK 持久卷探针失败')
    assert.equal(marker.stdout.trim(), 'byok-marker')
    assert.equal(fs.readFileSync(path.join(root, 'backend', '.env'), 'utf8'), 'ADMIN_PASSWORD=synthetic-integration-secret\nSYNTHETIC_CONFIG=preserve-me\n')

    const backupRoot = path.join(root, 'backup')
    const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot)[0])
    assert.ok(fs.statSync(path.join(backupDir, 'postgres.sql')).size > 0, '一体化更新必须先备份数据库')
  } finally {
    const down = run('docker', ['compose', '-p', id, '-f', path.join(root, 'compose.yml'), 'down', '-v', '--remove-orphans'], { cwd: root })
    if (down.status !== 0) process.stderr.write(`一体化隔离项目清理失败（${id}）：${down.stderr}`)
    run('docker', ['image', 'rm', '-f', ...imageTags])
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Docker Engine standalone 容器替换保留具名卷并在健康失败时恢复旧容器', { skip: !integrationEnabled }, () => {
  const id = `gugu-standalone-e2e-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`))
  const names = {
    old: `docker.io/coffeiz/gugu-web:${id}-old`,
    healthy: `docker.io/coffeiz/gugu-web:${id}-healthy`,
    failing: `docker.io/coffeiz/gugu-web:${id}-failing`,
  }
  const volume = `${id}-data`
  const containers = [`${id}-success`, `${id}-failure`]
  const python = path.join(repositoryRoot, 'backend/.venv/bin/python')
  const probe = `import json\nfrom updater.standalone import DockerEngine, DockerReplaceRecovered, snapshot_standalone_container\nengine = DockerEngine()\nengine.health_poll_interval = 0\nname, image, task = __import__('sys').argv[1:4]\nsnapshot = snapshot_standalone_container(engine.inspect_container(name))\ntry:\n    result = engine.replace_container(snapshot, image, task, pull_image=False)\n    outcome = 'updated'\nexcept DockerReplaceRecovered:\n    result = engine.inspect_container(name)['Id']\n    outcome = 'rolled_back'\nprint(json.dumps({'outcome': outcome, 'container_id': result, 'current': engine.inspect_container(name)['Id']}))\n`
  const imageTags = Object.values(names)
  try {
    const built = writeFixture(root, id)
    imageTags.push(...Object.values(built))
    requireSuccess(run('docker', ['image', 'tag', built.backendOld, names.old]), '标记 standalone 旧镜像失败')
    requireSuccess(run('docker', ['image', 'tag', built.backendNew, names.healthy]), '标记 standalone 健康镜像失败')
    requireSuccess(run('docker', ['image', 'tag', built.backendFail, names.failing]), '标记 standalone 故障镜像失败')
    requireSuccess(run('docker', ['volume', 'create', volume]), '创建 standalone 临时数据卷失败')

    for (const [name, target, task, expected] of [
      [containers[0], names.healthy, 'e2e-success', 'updated'],
      [containers[1], names.failing, 'e2e-failure', 'rolled_back'],
    ]) {
      requireSuccess(run('docker', [
        'run', '-d', '--name', name,
        '--env', 'GUGU_UNIFIED_APP=1', '--env', 'GUGU_EMBEDDED_DEPS=1',
        '--mount', `type=volume,source=${volume},target=/data`, names.old,
      ]), `启动 standalone 临时容器失败：${name}`)
      requireSuccess(run('docker', ['exec', name, 'sh', '-c', 'mkdir -p /data/byok && printf persistent-marker > /data/byok/.byok-master-key']), '写入 standalone 数据卷探针失败')
      const original = run('docker', ['inspect', '--format', '{{.Id}}', name]).stdout.trim()
      const result = run(python, ['-c', probe, name, target, task], { cwd: path.join(repositoryRoot, 'backend') })
      requireSuccess(result, `standalone Docker API 集成探针失败：${name}`)
      const observation = JSON.parse(result.stdout.trim())
      assert.equal(observation.outcome, expected)
      assert.equal(observation.current, observation.container_id)
      if (expected === 'updated') assert.notEqual(observation.current, original, '成功更新应替换 app 容器')
      else assert.equal(observation.current, original, '健康检查失败后必须恢复原容器 ID')
      const marker = run('docker', ['exec', name, 'cat', '/data/byok/.byok-master-key'])
      requireSuccess(marker, '验证 standalone BYOK 主密钥持久卷探针失败')
      assert.equal(marker.stdout.trim(), 'persistent-marker')
    }
  } finally {
    for (const name of [...containers, `${containers[0]}-gugu-previous-e2e-succ`, `${containers[1]}-gugu-previous-e2e-fai`]) {
      const inspect = run('docker', ['inspect', name])
      if (inspect.status === 0) run('docker', ['rm', '-f', name])
    }
    run('docker', ['volume', 'rm', volume])
    run('docker', ['image', 'rm', '-f', ...imageTags])
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('短期 standalone helper 在旧 app 被替换后继续运行并提交成功状态', { skip: !integrationEnabled }, () => {
  const id = `gugu-helper-e2e-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`))
  const oldImage = `docker.io/coffeiz/gugu-web:${id}-old`
  const helperImage = `docker.io/coffeiz/gugu-web:${id}-helper`
  const appName = `${id}-app`
  const helperName = `${id}-helper`
  const backupName = `${appName}-gugu-previous-helper-e`
  const dataDir = path.join(root, 'data')
  const imageTags = [oldImage, helperImage]
  let helperImageReady = false
  try {
    fs.mkdirSync(path.join(dataDir, 'updater'), { recursive: true })
    const built = writeFixture(root, id)
    imageTags.push(...Object.values(built))
    requireSuccess(run('docker', ['image', 'tag', built.backendOld, oldImage]), '标记 helper 旧 app 镜像失败')
    requireSuccess(run('docker', ['image', 'tag', built.backendNew, helperImage]), '标记短期 helper 镜像失败')
    helperImageReady = true
    requireSuccess(run('docker', [
      'run', '-d', '--name', appName,
      '--env', 'GUGU_UNIFIED_APP=1', '--env', 'GUGU_EMBEDDED_DEPS=1', '--env', 'DB__USER=e2e',
      '--mount', `type=bind,source=${dataDir},target=/data`, oldImage,
    ]), '启动 standalone 旧 app 容器失败')
    requireSuccess(run('docker', ['exec', appName, 'sh', '-c', 'mkdir -p /data/byok && printf helper-marker > /data/byok/.byok-master-key']), '写入 helper 集成持久数据探针失败')
    const dockerExecProbe = run('docker', [
      'run', '--rm',
      '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      helperImage, 'docker', 'exec', appName, 'pg_dumpall', '-U', 'e2e',
    ])
    requireSuccess(dockerExecProbe, '验证 helper 容器通过 Docker socket 执行数据库备份探针失败')
    assert.match(dockerExecProbe.stdout, /PostgreSQL database cluster dump/)

    const python = path.join(repositoryRoot, 'backend/.venv/bin/python')
    const snapshotCode = `import json, sys\nfrom updater.standalone import DockerEngine, snapshot_standalone_container\nprint(json.dumps(snapshot_standalone_container(DockerEngine().inspect_container(sys.argv[1]))))\n`
    const snapshotResult = run(python, ['-c', snapshotCode, appName], { cwd: path.join(repositoryRoot, 'backend') })
    requireSuccess(snapshotResult, '读取 standalone helper 集成容器配置失败')
    const snapshot = JSON.parse(snapshotResult.stdout.trim())
    const taskId = 'helper-e2e-task'
    const state = {
      task: { id: taskId, status: 'updating', stage: 'preflight', progress: 60, events: [], updated_at: 'synthetic', completed_at: null },
      history: [{ id: taskId, status: 'updating', stage: 'preflight', progress: 60, events: [], updated_at: 'synthetic', completed_at: null }],
    }
    fs.writeFileSync(path.join(dataDir, 'updater', 'state.json'), JSON.stringify(state), { mode: 0o600 })
    fs.writeFileSync(path.join(dataDir, 'updater', 'handoff.json'), JSON.stringify({
      task_id: taskId,
      version: 'v9.8.7',
      image: helperImage,
      database_backup: '/data/updater/backups/standalone-helper-e2e.sql',
      pull_image: false,
      snapshot,
    }), { mode: 0o600 })
    const oldContainerId = snapshot.container_id

    requireSuccess(run('docker', [
      'run', '-d', '--name', helperName,
      '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '--mount', `type=bind,source=${dataDir},target=/data`,
      '--env', 'GUGU_UPDATER_HANDOFF_FILE=/data/updater/handoff.json',
      '--env', 'GUGU_UPDATER_STATE_DIR=/data/updater',
      '--env', 'GUGU_DOCKER_SOCKET=/var/run/docker.sock',
      helperImage, 'python', '-m', 'updater.standalone_helper',
    ]), '启动独立 standalone helper 失败')
    const wait = run('docker', ['wait', helperName], { timeout: 120_000 })
    requireSuccess(wait, '等待 standalone helper 退出失败')
    const helperLogs = run('docker', ['logs', helperName])
    const stateRead = run('docker', [
      'run', '--rm', '--mount', `type=bind,source=${dataDir},target=/data`,
      helperImage, 'python', '-c', 'print(open("/data/updater/state.json").read())',
    ])
    requireSuccess(stateRead, '以 helper 权限读取 standalone 状态失败')
    const stateAfter = JSON.parse(stateRead.stdout.trim())
    assert.equal(wait.stdout.trim(), '0', `helper 应在 app 容器重建后独立完成任务\nhelper logs: ${helperLogs.stdout}\nstate: ${JSON.stringify(stateAfter)}`)
    assert.equal(stateAfter.task.status, 'succeeded')
    assert.equal(stateAfter.current.image, helperImage)
    assert.equal(stateAfter.current.version, 'v9.8.7')
    assert.notEqual(run('docker', ['inspect', '--format', '{{.Id}}', appName]).stdout.trim(), oldContainerId)
    const backupRead = run('docker', [
      'run', '--rm', '--mount', `type=bind,source=${dataDir},target=/data`,
      helperImage, 'python', '-c', 'print(open("/data/updater/backups/standalone-helper-e2e.sql").read())',
    ])
    requireSuccess(backupRead, '以 helper 权限读取数据库备份失败')
    assert.match(backupRead.stdout, /PostgreSQL database cluster dump/)
    const marker = run('docker', ['exec', appName, 'cat', '/data/byok/.byok-master-key'])
    requireSuccess(marker, 'helper 替换后读取 BYOK 持久数据失败')
    assert.equal(marker.stdout.trim(), 'helper-marker')
  } finally {
    for (const name of [helperName, appName, backupName]) {
      const inspect = run('docker', ['inspect', name])
      if (inspect.status === 0) run('docker', ['rm', '-f', name])
    }
    if (helperImageReady && fs.existsSync(dataDir)) {
      const cleanData = run('docker', [
        'run', '--rm', '--mount', `type=bind,source=${dataDir},target=/cleanup`,
        helperImage, 'python', '-c', 'import shutil; shutil.rmtree("/cleanup", ignore_errors=True)',
      ])
      if (cleanData.status !== 0) process.stderr.write(`standalone 临时数据目录清理失败：${cleanData.stderr}`)
    }
    run('docker', ['image', 'rm', '-f', ...imageTags])
    fs.rmSync(root, { recursive: true, force: true })
  }
})
