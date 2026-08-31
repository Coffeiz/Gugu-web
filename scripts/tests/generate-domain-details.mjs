#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'docs/reports/2026-08-31-TEST-INVENTORY.json'), 'utf8'))
const outputPath = path.join(root, 'docs/reports/2026-08-31-TEST-DOMAIN-DETAILS.md')

function testNames(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const names = []
  for (const match of source.matchAll(/^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)/gm)) names.push(match[1])
  for (const match of source.matchAll(/\b(?:it|test)\s*\(\s*['"]([^'"]+)/g)) names.push(match[1])
  return [...new Set(names)]
}

function detail(item) {
  const names = testNames(item.file)
  const flags = [item.externalDependency ? '外部依赖' : '无外部依赖', item.hasSkip ? '含 skip' : '无 skip']
  return [
    `### ${item.file}`,
    '',
    `- 类型/层级：${item.kind} / ${item.layer}`,
    `- owner：${item.owner}`,
    `- 源码声明数：${item.declaredTestCount}；${flags.join('；')}`,
    '- 测试内容：',
    names.length ? names.map(name => `  - ${name}`).join('\n') : '  - 脚本入口或静态检查，无标准测试函数',
    '',
  ].join('\n')
}

const domains = new Map()
for (const item of inventory.items) {
  if (!domains.has(item.domain)) domains.set(item.domain, [])
  domains.get(item.domain).push(item)
}

const lines = [
  '# 测试领域详细内容',
  '',
  '> 由 `scripts/tests/generate-domain-details.mjs` 根据测试源码生成。用于 Phase 2 逐文件核对职责和测试内容，不替代运行器实际收集结果。',
  '',
]
for (const [domain, items] of domains) {
  lines.push(`## ${domain}`, '', `- 文件数：${items.length}`, `- 源码声明数：${items.reduce((sum, item) => sum + item.declaredTestCount, 0)}`, '')
  lines.push(...items.map(detail))
}

fs.writeFileSync(outputPath, `${lines.join('\n')}\n`)
console.log(`已生成 ${path.relative(root, outputPath)}，覆盖 ${inventory.items.length} 个测试资产。`)
