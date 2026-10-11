#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const metadataPath = path.join(root, 'docs/testing/test-metadata.json')
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
const testPattern = /(^|\/)(test_[^/]+\.py|[^/]+\.(test|spec)\.(ts|js))$/

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

let base = process.env.GITHUB_BASE_SHA?.trim()
if (!base) {
  try {
    base = git(['merge-base', 'HEAD', 'origin/main'])
  } catch {
    console.error('[测试元数据] 无法确定比较基线；请提供 GITHUB_BASE_SHA，或准备 origin/main。')
    process.exit(2)
  }
  if (!base) {
    console.error('[测试元数据] merge-base 结果为空；拒绝使用 HEAD 自比较。')
    process.exit(2)
  }
}
let names = []
try {
  names = git(['diff', '--name-status', '--diff-filter=A', `${base}...HEAD`]).split('\n').filter(Boolean)
} catch {
  names = git(['diff', '--name-status', '--diff-filter=A', base]).split('\n').filter(Boolean)
}

const added = new Set()
for (const line of names) {
  const parts = line.split('\t')
  const file = parts.at(-1)
  if (file && testPattern.test(file)) added.add(file)
}

const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean))
const trackedTests = [...tracked].filter(file => testPattern.test(file))
const deletedFrontendTests = trackedTests.filter(file =>
  /^frontend\/(?:src|test)\//.test(file) && !fs.existsSync(path.join(root, file)),
)
const untrackedTests = git(['ls-files', '-o', '--exclude-standard']).split('\n')
  .filter(file => testPattern.test(file) && !tracked.has(file))

// 本地搬迁尚未暂存时，Git 会把新路径列为 untracked、旧路径列为 deleted。
// 同名一一配对视为移动，避免要求搬迁者为原有测试重复填写新增元数据。
const deletedByName = new Map()
const untrackedByName = new Map()
for (const file of deletedFrontendTests) {
  const name = path.basename(file)
  deletedByName.set(name, [...(deletedByName.get(name) || []), file])
}
for (const file of untrackedTests.filter(item => item.startsWith('frontend/tests/'))) {
  const name = path.basename(file)
  untrackedByName.set(name, [...(untrackedByName.get(name) || []), file])
}
const relocated = new Set()
for (const [name, oldPaths] of deletedByName) {
  const newPaths = untrackedByName.get(name) || []
  if (oldPaths.length === newPaths.length) newPaths.forEach(file => relocated.add(file))
}
for (const file of untrackedTests) {
  if (!relocated.has(file)) added.add(file)
}

const required = ['domain', 'layer', 'owner', 'productionEntry', 'keyBehavior', 'ci']
const errors = []
for (const file of added) {
  const item = metadata[file]
  if (!item) {
    errors.push(`${file}: 缺少 docs/testing/test-metadata.json 条目`)
    continue
  }
  for (const field of required) {
    if (item[field] === undefined || item[field] === '') errors.push(`${file}: 缺少 ${field}`)
  }
}

if (errors.length) {
  console.error('[测试元数据] 校验失败：')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}
console.log(`[测试元数据] 通过：基线 ${base}，检查新增测试 ${added.size} 个；要求 domain/layer/owner/productionEntry/keyBehavior/ci。`)
