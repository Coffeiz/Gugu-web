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
if [[ "$1" == inspect ]]; then
  if [[ "$*" == *backend-id* || "$*" == *sandboxd-id* ]]; then echo 'docker.io/coffeiz/gugu-web-backend:v1.2.1'; else echo 'docker.io/coffeiz/gugu-web-frontend:v1.2.1'; fi
  exit 0
fi
[[ "$1" == compose ]] || exit 90
shift
while (($#)); do case "$1" in --project-directory|-f|--profile) shift 2 ;; *) break ;; esac; done
command_name="$1"; shift
case "$command_name" in
  config)
    if [[ "$*" == *'--format json'* ]]; then
      printf '%s\\n' '{"services":{"postgres":{},"redis":{},"migrate":{},"backend":{},"worker":{},"gateway":{},"frontend":{},"nginx":{},"sandboxd":{}}}'
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
    if [[ "$*" == *'postgres pg_dumpall'* ]]; then echo '-- PostgreSQL database cluster dump'; fi
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
    assert.doesNotMatch(log, /down -v|system prune/)
    const backupRoot = path.join(f.root, 'backup')
    const backup = path.join(backupRoot, fs.readdirSync(backupRoot)[0])
    assert.equal(fs.readFileSync(path.join(backup, 'backend.env'), 'utf8'), 'ADMIN_PASSWORD=synthetic\n')
    assert.match(fs.readFileSync(path.join(backup, 'postgres.sql'), 'utf8'), /PostgreSQL database cluster dump/)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('仅当运行中的 sandboxd 与 backend 镜像引用完全一致时同步更新及回滚它', () => {
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
