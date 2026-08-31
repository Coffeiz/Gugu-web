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

const base = process.env.GITHUB_BASE_SHA || 'HEAD'
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
for (const file of git(['ls-files', '-o', '--exclude-standard']).split('\n').filter(Boolean)) {
  if (testPattern.test(file) && !tracked.has(file)) added.add(file)
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
console.log(`[测试元数据] 通过：检查新增测试 ${added.size} 个；要求 domain/layer/owner/productionEntry/keyBehavior/ci。`)
