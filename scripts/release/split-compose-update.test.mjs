import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const releaseDir = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(releaseDir, 'split-compose-update.sh')
const validator = path.join(releaseDir, 'validate-update-manifest.mjs')
const backendTarget = `docker.io/coffeiz/gugu-web-backend@sha256:${'b'.repeat(64)}`
const frontendTarget = `docker.io/coffeiz/gugu-web-frontend@sha256:${'c'.repeat(64)}`

const mockDocker = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [[ "$1" == --host ]]; then
  shift 2
  case "$1" in
    info) [[ "\${MOCK_BAD_ROOTLESS:-false}" != true ]] || exit 1; echo '["name=rootless"]' ;;
    ps) echo own-shell; echo foreign-shell ;;
    inspect)
      if [[ "$*" == *State.Running* ]]; then
        if [[ "\${MOCK_STUCK_SHELL:-false}" == true ]]; then echo true; else echo false; fi
      elif [[ "$*" == *own-shell* ]]; then echo '[{"Source":"/synthetic/data/users/moon/workspace"}]'
      else echo '[{"Source":"/synthetic/other-data/users/moon/workspace"}]'; fi ;;
    stop) ;;
    *) exit 90 ;;
  esac
  exit 0
fi
if [[ "$1" == inspect ]]; then
  if [[ "$*" == *'json .Mounts'* ]]; then echo '[{"Destination":"/data","Source":"/synthetic/data"}]'; exit 0; fi
  if [[ "$*" == *backend-id* || "$*" == *sandboxd-id* ]]; then echo 'docker.io/coffeiz/gugu-web-backend:v1.2.1'; else echo 'docker.io/coffeiz/gugu-web-frontend:v1.2.1'; fi
  exit 0
fi
if [[ "$1" == ps ]]; then exit 0; fi
[[ "$1" == compose ]] || exit 90
shift
while (($#)); do case "$1" in --project-directory|-f|--profile) shift 2 ;; *) break ;; esac; done
command_name="$1"; shift
case "$command_name" in
  config)
    if [[ "$*" == *'--format json'* ]]; then
      if [[ "\${MOCK_EXTERNAL:-false}" == true ]]; then
        printf '%s\\n' '{"services":{"postgres":{},"redis":{},"migrate":{},"backend":{},"worker":{},"gateway":{},"frontend":{},"nginx":{}}}'
      else
        printf '%s\\n' '{"services":{"postgres":{},"redis":{},"migrate":{},"backend":{},"worker":{},"gateway":{},"frontend":{},"nginx":{},"sandboxd":{}}}'
      fi
    else
      printf '%s\\n' postgres redis migrate backend worker gateway frontend nginx sandboxd
    fi
    ;;
  ps)
    if [[ "$*" == *"-q backend"* ]]; then echo backend-id
    elif [[ "$*" == *"-q frontend"* ]]; then echo frontend-id
    elif [[ "$*" == *"-q sandboxd"* ]]; then echo sandboxd-id
    elif [[ "$*" == *"sandboxd"* ]]; then [[ "${'${MOCK_SANDBOXD:-false}'}" == true ]] && echo sandboxd || true
    elif [[ "$*" == *"--services"* ]]; then printf 'postgres\\nredis\\nbackend\\nfrontend\\n'
    fi
    ;;
  exec)
    if [[ "$*" == *'backend curl'* && "${'${MOCK_FAIL_HEALTH:-false}'}" == true ]]; then exit 22; fi
    if [[ "$*" == *'postgres pg_dumpall'* ]]; then echo '-- PostgreSQL database cluster dump'; fi
    ;;
  run)
    if [[ "$*" == *'--entrypoint tar'* ]]; then tar -C "$MOCK_STORAGE_DIR" -cpf - users; fi
    if [[ "$*" == *'--entrypoint bash'* && "${'${MOCK_FAIL_MIGRATION:-false}'}" == true ]]; then exit 42; fi
    ;;
  *) ;;
esac
`

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-split-update-test-'))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.mkdirSync(path.join(root, 'backend'))
  fs.writeFileSync(path.join(root, 'backend', '.env'), 'ADMIN_PASSWORD=synthetic\n')
  fs.writeFileSync(path.join(root, 'docker-compose.prod.yml'), 'services: {}\n')
  fs.writeFileSync(path.join(bin, 'docker'), mockDocker, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'manager.state'), 'running')
  fs.writeFileSync(path.join(root, 'manager-control'), `#!/bin/bash
set -e
printf 'manager %s\\n' "$1" >> "$MOCK_DOCKER_LOG"
case "$1" in
  status) cat "$MANAGER_STATE" ;;
  stop) [[ "\${MOCK_STUCK_MANAGER:-false}" != true ]] && printf stopped > "$MANAGER_STATE" || true ;;
  start) printf running > "$MANAGER_STATE" ;;
esac
`, { mode: 0o755 })
  fs.mkdirSync(path.join(root, 'storage', 'users'), { recursive: true })
  fs.writeFileSync(path.join(root, 'storage', 'users', 'sentinel'), 'preserved')
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schema_version: 3, version: 'v1.2.2', channel: 'stable', minimum_version: 'v1.2.1',
    app_image: `docker.io/coffeiz/gugu-web@sha256:${'a'.repeat(64)}`,
    split_images: { backend_image: backendTarget, frontend_image: frontendTarget },
    architectures: ['linux/amd64'], database_migration: true,
    release_notes_url: 'https://github.com/Coffeiz/Gugu-web/releases/tag/v1.2.2', rollback_supported: true,
  }))
  return { root, bin, log: path.join(root, 'docker.log') }
}

function run(f, extraEnv = {}) {
  return spawnSync('bash', [script, path.join(f.root, 'manifest.json')], {
    cwd: f.root, encoding: 'utf8', env: {
      ...process.env, PATH: `${f.bin}:${process.env.PATH}`, MOCK_DOCKER_LOG: f.log,
      COMPOSE_PROJECT_DIR: f.root, COMPOSE_FILE: path.join(f.root, 'docker-compose.prod.yml'),
      BACKUP_ROOT: path.join(f.root, 'backup'), UPDATE_VALIDATOR: validator,
      UPDATE_SCHEMA: path.resolve(releaseDir, '../../deploy/update-manifest.schema.json'),
      MOCK_STORAGE_DIR: path.join(f.root, 'storage'),
      MANAGER_STATE: path.join(f.root, 'manager.state'),
      ...extraEnv,
    },
  })
}

test('分体更新备份配置与数据库，验证迁移后按固定服务顺序重建并保留数据卷', () => {
  const f = fixture()
  try {
    const result = run(f)
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${fs.readFileSync(f.log, 'utf8')}`)
    const log = fs.readFileSync(f.log, 'utf8')
    assert.match(log, /pull migrate backend worker gateway frontend/)
    assert.match(log, /run --rm --no-deps --entrypoint python backend -m updater.database_check/)
    assert.match(log, /up -d --no-deps --force-recreate backend/)
    assert.match(log, /up -d --no-deps --force-recreate worker gateway frontend/)
    const stopped = log.indexOf('stop backend worker gateway sandboxd')
    const databaseBackup = log.indexOf('postgres pg_dumpall')
    const storageBackup = log.indexOf('--entrypoint tar')
    const migration = log.indexOf('--entrypoint bash')
    assert.ok(stopped >= 0 && stopped < databaseBackup && databaseBackup < storageBackup && storageBackup < migration)
    assert.ok(migration < log.indexOf('up -d --no-deps --force-recreate backend'))
    assert.doesNotMatch(log, /down -v|system prune/)
    const backupRoot = path.join(f.root, 'backup')
    const backup = path.join(backupRoot, fs.readdirSync(backupRoot)[0])
    assert.equal(fs.readFileSync(path.join(backup, 'backend.env'), 'utf8'), 'ADMIN_PASSWORD=synthetic\n')
    assert.match(fs.readFileSync(path.join(backup, 'postgres.sql'), 'utf8'), /PostgreSQL database cluster dump/)
    const archive = spawnSync('tar', ['-tf', path.join(backup, 'users.tar')], { encoding: 'utf8' })
    assert.equal(archive.status, 0)
    assert.match(archive.stdout, /users\/sentinel/)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('external manager 与当前部署 Rootless 执行容器停止后才备份，成功后恢复 manager', () => {
  const f = fixture()
  try {
    const result = run(f, {
      MOCK_EXTERNAL: 'true', EXTERNAL_SANDBOX_CONTROL: path.join(f.root, 'manager-control'),
      EXTERNAL_SANDBOX_DOCKER_HOST: 'unix:///synthetic/rootless.sock',
    })
    assert.equal(result.status, 0, result.stderr)
    const log = fs.readFileSync(f.log, 'utf8')
    assert.ok(log.indexOf('manager stop') < log.indexOf('stop own-shell'))
    assert.ok(log.indexOf('stop own-shell') < log.indexOf('postgres pg_dumpall'))
    assert.doesNotMatch(log, /stop foreign-shell/)
    assert.ok(log.indexOf('manager start') > log.indexOf('up -d --no-deps --force-recreate worker gateway frontend'))
    assert.equal(fs.readFileSync(path.join(f.root, 'manager.state'), 'utf8'), 'running')
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

for (const failure of ['missing', 'MOCK_STUCK_MANAGER', 'MOCK_BAD_ROOTLESS', 'MOCK_STUCK_SHELL']) {
  test(`external 停服无法证明时拒绝数据库和 users 备份：${failure}`, () => {
    const f = fixture()
    try {
      const env = { MOCK_EXTERNAL: 'true' }
      if (failure !== 'missing') Object.assign(env, {
        EXTERNAL_SANDBOX_CONTROL: path.join(f.root, 'manager-control'),
        EXTERNAL_SANDBOX_DOCKER_HOST: 'unix:///synthetic/rootless.sock', [failure]: 'true',
      })
      const result = run(f, env)
      assert.notEqual(result.status, 0)
      const log = fs.readFileSync(f.log, 'utf8')
      assert.doesNotMatch(log, /pg_dumpall|--entrypoint tar|--entrypoint bash|manager start/)
    } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
  })
}

for (const failure of ['MOCK_FAIL_HEALTH', 'MOCK_FAIL_MIGRATION']) {
  test(`${failure} 后保持人工恢复态，禁止只回滚镜像`, () => {
    const f = fixture()
    try {
      const result = run(f, { [failure]: 'true' })
      assert.notEqual(result.status, 0)
      const log = fs.readFileSync(f.log, 'utf8')
      assert.doesNotMatch(log, /up -d --pull never/)
      assert.doesNotMatch(log, /force-recreate worker gateway frontend/)
      assert.match(result.stderr, /禁止只降级镜像/)
      const backup = path.join(f.root, 'backup', fs.readdirSync(path.join(f.root, 'backup'))[0])
      assert.equal(fs.readFileSync(path.join(backup, 'recovery-required'), 'utf8').trim(), 'manual-recovery')
    } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
  })
}

test('仅当运行中的 sandboxd 与 backend 镜像引用完全一致时同步更新它', () => {
  const f = fixture()
  try {
    const result = run(f, { MOCK_SANDBOXD: 'true' })
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${fs.readFileSync(f.log, 'utf8')}`)
    const log = fs.readFileSync(f.log, 'utf8')
    assert.match(log, /pull migrate backend worker gateway frontend sandboxd/)
    assert.match(log, /up -d --no-deps --force-recreate sandboxd/)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
