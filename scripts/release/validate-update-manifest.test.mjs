import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('./validate-update-manifest.mjs', import.meta.url))
const schemaPath = fileURLToPath(new URL('../../deploy/update-manifest.schema.json', import.meta.url))
const digestA = 'a'.repeat(64)
const digestB = 'b'.repeat(64)

function makeManifest(registry = 'docker.io') {
  return {
    schema_version: 3,
    version: 'v1.2.2',
    channel: 'stable',
    minimum_version: 'v1.2.1',
    app_image: `${registry}/coffeiz/gugu-web@sha256:${digestA}`,
    split_images: {
      backend_image: `docker.io/coffeiz/gugu-web-backend@sha256:${digestB}`,
      frontend_image: `docker.io/coffeiz/gugu-web-frontend@sha256:${digestA}`,
    },
    architectures: ['linux/amd64'],
    database_migration: true,
    release_notes_url: 'https://github.com/Coffeiz/Gugu-web/releases/tag/v1.2.2',
    rollback_supported: true,
  }
}

function runManifestCheck(manifest) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-manifest-check-'))
  const manifestPath = path.join(tempDir, 'manifest.json')
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    return spawnSync(process.execPath, [scriptPath, manifestPath], { encoding: 'utf8' })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

test('Schema 与校验器允许 Docker Hub 主源和 GHCR 镜像的一体化应用 digest', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--schema', schemaPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('接受带完整镜像组的 Docker Hub manifest', () => {
  const result = runManifestCheck(makeManifest('docker.io'))
  assert.equal(result.status, 0, result.stderr)
})

test('接受 GHCR app 镜像及完整分体镜像组', () => {
  const result = runManifestCheck(makeManifest('ghcr.io'))
  assert.equal(result.status, 0, result.stderr)
})

test('接受同时携带不可变 backend/frontend digest 的 v3 manifest', () => {
  const manifest = {
    ...makeManifest(),
    split_images: {
      backend_image: `docker.io/coffeiz/gugu-web-backend@sha256:${digestB}`,
      frontend_image: `ghcr.io/coffeiz/gugu-web-frontend@sha256:${digestA}`,
    },
  }
  const result = runManifestCheck(manifest)
  assert.equal(result.status, 0, result.stderr)
})

test('v3 拆分镜像组缺失、使用 tag 或出现未知字段时拒绝 manifest', () => {
  const base = makeManifest()
  const invalid = [
    { ...base, split_images: undefined },
    { ...base, split_images: { backend_image: `docker.io/coffeiz/gugu-web-backend@sha256:${digestB}` } },
    { ...base, split_images: { backend_image: 'docker.io/coffeiz/gugu-web-backend:v1.2.2', frontend_image: `docker.io/coffeiz/gugu-web-frontend@sha256:${digestA}` } },
    { ...base, split_images: { backend_image: `docker.io/coffeiz/gugu-web-backend@sha256:${digestB}`, frontend_image: `docker.io/coffeiz/gugu-web-frontend@sha256:${digestA}`, extra: true } },
  ]
  for (const manifest of invalid) assert.notEqual(runManifestCheck(manifest).status, 0)
})

test('拒绝非白名单仓库、镜像 tag、拆分业务镜像和错误仓库', () => {
  const invalidManifests = [
    makeManifest('registry.example.com'),
    { ...makeManifest(), app_image: `docker.io/attacker/gugu-web@sha256:${digestA}` },
    { ...makeManifest(), app_image: 'docker.io/coffeiz/gugu-web:v1.2.2' },
    { ...makeManifest(), app_image: `docker.io/coffeiz/gugu-web-backend@sha256:${digestA}` },
    { ...makeManifest(), app_image: `docker.io/coffeiz/gugu-web-worker@sha256:${digestA}` },
    { ...makeManifest(), schema_version: 2 },
    { ...makeManifest(), schema_version: 1 },
  ]

  for (const manifest of invalidManifests) {
    const result = runManifestCheck(manifest)
    assert.notEqual(result.status, 0, JSON.stringify(manifest))
  }
})

test('打印更新器唯一需要覆盖的一体化 Compose 镜像变量', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-manifest-check-'))
  const manifestPath = path.join(tempDir, 'manifest.json')
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(makeManifest()))
    const result = spawnSync(process.execPath, [scriptPath, '--print-images', manifestPath], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), `GUGU_WEB_IMAGE=${makeManifest().app_image}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
