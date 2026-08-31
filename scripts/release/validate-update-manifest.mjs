#!/usr/bin/env node

import fs from 'node:fs'
import process from 'node:process'

const required = [
  'schema_version', 'version', 'channel', 'minimum_version',
  'backend_image', 'frontend_image', 'architectures',
  'database_migration', 'release_notes_url', 'rollback_supported',
]
const semver = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const image = /^ghcr\.io\/coffeiz\/gugu-web-[a-z0-9-]+@sha256:[0-9a-f]{64}$/

function fail(message) {
  console.error(`manifest 校验失败：${message}`)
  process.exit(1)
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${path} 不是有效 JSON：${error.message}`)
  }
}

function validateSchema(schema) {
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    fail('Schema 必须是禁止额外字段的 object')
  }
  if (JSON.stringify(schema.required) !== JSON.stringify(required)) {
    fail('Schema required 字段与发布契约不一致')
  }
  if (schema.properties?.schema_version?.const !== 1) {
    fail('Schema schema_version 必须固定为 1')
  }
  const pattern = schema.$defs?.immutableImage?.pattern
  if (pattern !== '^ghcr\\.io/coffeiz/gugu-web-[a-z0-9-]+@sha256:[0-9a-f]{64}$') {
    fail('Schema 未限制为 Coffeiz Gugu-web 的不可变 GHCR digest')
  }
}

function validateManifest(manifest) {
  const keys = new Set(Object.keys(manifest))
  for (const field of required) {
    if (!keys.has(field)) fail(`缺少字段 ${field}`)
  }
  const allowed = new Set([...required, 'git_sha', 'published_at'])
  for (const field of keys) {
    if (!allowed.has(field)) fail(`不允许的字段 ${field}`)
  }
  if (manifest.schema_version !== 1) fail('schema_version 必须为 1')
  if (!semver.test(manifest.version) || !semver.test(manifest.minimum_version)) {
    fail('version 和 minimum_version 必须是 semver')
  }
  if (!['stable', 'beta'].includes(manifest.channel)) fail('channel 不受支持')
  if (!image.test(manifest.backend_image) || !image.test(manifest.frontend_image)) {
    fail('业务镜像必须是允许的 GHCR digest 引用')
  }
  if (!Array.isArray(manifest.architectures) || manifest.architectures.length === 0) {
    fail('architectures 不能为空')
  }
  if (manifest.architectures.some((value) => !['linux/amd64', 'linux/arm64'].includes(value))) {
    fail('architectures 包含不支持的平台')
  }
  if (typeof manifest.database_migration !== 'boolean' || typeof manifest.rollback_supported !== 'boolean') {
    fail('database_migration 和 rollback_supported 必须是 boolean')
  }
  if (!/^https:\/\/github\.com\/Coffeiz\/Gugu-web\/releases\//.test(manifest.release_notes_url)) {
    fail('release_notes_url 必须指向 Gugu-web GitHub Release')
  }
  if (manifest.git_sha !== undefined && !/^[0-9a-f]{40}$/.test(manifest.git_sha)) {
    fail('git_sha 必须是 40 位小写 SHA')
  }
  if (manifest.published_at !== undefined && Number.isNaN(Date.parse(manifest.published_at))) {
    fail('published_at 必须是有效时间')
  }
}

const args = process.argv.slice(2)
if (args[0] === '--schema') {
  validateSchema(readJson(args[1]))
  console.log('manifest Schema 校验通过')
} else if (args[0] === '--print-images') {
  const manifest = readJson(args[1])
  validateManifest(manifest)
  console.log(`GUGU_BACKEND_IMAGE=${manifest.backend_image}`)
  console.log(`GUGU_FRONTEND_IMAGE=${manifest.frontend_image}`)
} else if (args[0]) {
  validateManifest(readJson(args[0]))
  console.log('update manifest 校验通过')
} else {
  fail('用法：validate-update-manifest.mjs [--schema|--print-images] <文件>')
}
