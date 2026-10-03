#!/usr/bin/env node

import fs from 'node:fs'
import process from 'node:process'

const required = [
  'schema_version', 'version', 'channel', 'minimum_version',
  'app_image', 'split_images', 'architectures',
  'database_migration', 'release_notes_url', 'rollback_supported',
]
const semver = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const appImage = /^(?:docker\.io|ghcr\.io)\/coffeiz\/gugu-web@sha256:[0-9a-f]{64}$/
const backendImage = /^(?:docker\.io|ghcr\.io)\/coffeiz\/gugu-web-backend@sha256:[0-9a-f]{64}$/
const frontendImage = /^(?:docker\.io|ghcr\.io)\/coffeiz\/gugu-web-frontend@sha256:[0-9a-f]{64}$/
const appImagePattern = '^(?:docker\\.io|ghcr\\.io)/coffeiz/gugu-web@sha256:[0-9a-f]{64}$'

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
  if (schema.properties?.schema_version?.const !== 3) {
    fail('Schema schema_version 必须只支持 v3')
  }
  if (schema.properties?.app_image?.pattern !== appImagePattern) {
    fail('Schema 未限制为 Docker Hub 或 GHCR 一体化应用镜像 digest')
  }
}

function validateManifest(manifest) {
  const keys = new Set(Object.keys(manifest))
  for (const field of required) {
    if (!keys.has(field)) fail(`缺少字段 ${field}`)
  }
  const allowed = new Set([...required, 'git_sha', 'published_at', 'app_bundle'])
  for (const field of keys) {
    if (!allowed.has(field)) fail(`不允许的字段 ${field}`)
  }
  if (manifest.schema_version !== 3) fail('schema_version 仅支持 v3；v2 已停止支持')
  if (!semver.test(manifest.version) || !semver.test(manifest.minimum_version)) {
    fail('version 和 minimum_version 必须是 semver')
  }
  if (!['stable', 'beta'].includes(manifest.channel)) fail('channel 不受支持')
  if (!appImage.test(manifest.app_image)) {
    fail('应用镜像必须是允许的 Docker Hub 或 GHCR 一体化应用 digest 引用')
  }
  const split = manifest.split_images
  if (!split || typeof split !== 'object' || Array.isArray(split)) fail('split_images 必须是对象')
  if (Object.keys(split).length !== 2 || !backendImage.test(split.backend_image || '') || !frontendImage.test(split.frontend_image || '')) {
    fail('split_images 必须包含白名单 backend/frontend digest，且不得有额外字段')
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
  if (manifest.app_bundle !== undefined) {
    const bundle = manifest.app_bundle
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) fail('app_bundle 必须是对象')
    const expectedArchive = `gugu-app-${manifest.version}.tar.gz`
    const expectedSignature = `gugu-app-${manifest.version}.sigstore.json`
    if (bundle.archive !== expectedArchive || bundle.signature_bundle !== expectedSignature) {
      fail('app_bundle 资源名称必须与版本一致')
    }
    if (!/^[0-9a-f]{64}$/.test(bundle.sha256 || '')) fail('app_bundle.sha256 必须是 SHA-256')
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(bundle.runtime_contract || '')) fail('app_bundle.runtime_contract 格式无效')
    if (!Number.isSafeInteger(bundle.size) || bundle.size < 1 || bundle.size > 536870912) fail('app_bundle.size 超出限制')
    if (!Number.isSafeInteger(bundle.unpacked_size) || bundle.unpacked_size < 1 || bundle.unpacked_size > 1073741824) fail('app_bundle.unpacked_size 超出限制')
    if (Object.keys(bundle).sort().join(',') !== 'archive,runtime_contract,sha256,signature_bundle,size,unpacked_size') {
      fail('app_bundle 字段不完整或包含未知字段')
    }
  }
}

const args = process.argv.slice(2)
if (args[0] === '--schema') {
  validateSchema(readJson(args[1]))
  console.log('manifest Schema 校验通过')
  } else if (args[0] === '--print-images') {
  const manifest = readJson(args[1])
  validateManifest(manifest)
  console.log(`GUGU_WEB_IMAGE=${manifest.app_image}`)
} else if (args[0]) {
  validateManifest(readJson(args[0]))
  console.log('update manifest 校验通过')
} else {
  fail('用法：validate-update-manifest.mjs [--schema|--print-images] <文件>')
}
