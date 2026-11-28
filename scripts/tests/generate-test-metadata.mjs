#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { groupFor, loadMetadata, metadataDir, root } from './test-metadata.mjs'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：pnpm test:metadata:generate <测试文件> [...]')
  process.exit(2)
}
const existing = loadMetadata()
const groups = new Map()
for (const file of files) {
  if (path.isAbsolute(file) || file.split('/').includes('..') || !/(^|\/)(test_[^/]+\.py|[^/]+_test\.py|[^/]+\.(test|spec)\.(ts|js))$/.test(file) || !fs.existsSync(path.join(root,file))) throw new Error(`无效的测试文件：${file}`)
  if (Object.hasOwn(existing,file)) { console.log(`已登记：${file}`); continue }
  const group = groupFor(file), target = path.join(metadataDir, `${group}.json`)
  if (!groups.has(target)) groups.set(target, fs.existsSync(target) ? JSON.parse(fs.readFileSync(target,'utf8')) : {})
  const ci = file.startsWith('packages/core/') ? 'core-node' : file.startsWith('apps/web-host/') ? 'node-webui' : file.startsWith('backend/') ? 'backend-pytest' : ''
  groups.get(target)[file] = {domain:group, layer:'', owner:'', productionEntry:'', keyBehavior:'', ci}
  existing[file] = true
  console.log(`已生成草稿：${file}；请填写空字段并确认分类`)
}
for (const [target,items] of groups) fs.writeFileSync(target, JSON.stringify(items,null,2)+'\n')
