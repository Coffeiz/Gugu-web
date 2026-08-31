#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const inventoryPath = path.join(root, 'docs/reports/2026-08-31-TEST-INVENTORY.json')
const outputPath = path.join(root, 'docs/reports/2026-08-31-TEST-INVENTORY-DETAILS.md')
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'))

function declaredNames(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const names = []
  for (const match of source.matchAll(/^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)/gm)) names.push(match[1])
  for (const match of source.matchAll(/\b(?:it|test)\s*\(\s*['"]([^'"]+)/g)) names.push(match[1])
  return [...new Set(names)]
}

function detail(item) {
  const names = declaredNames(item.file)
  const dependency = item.externalDependency ? '有外部依赖' : '无外部依赖'
  const skip = item.hasSkip ? '含 skip，需人工确认触发条件' : '无 skip'
  const tests = names.length ? names.map(name => `- ${name}`).join('\n') : '- 脚本入口或静态检查，无标准测试函数'
  return [
    `### ${item.file}`,
    '',
    `- 类型/层级：${item.kind} / ${item.layer}`,
    `- 自动领域/owner：${item.domain} / ${item.ownerReview === '待复核' ? '待确认' : item.owner}`,
    `- 源码声明数：${item.declaredTestCount}；${dependency}；${skip}`,
    '- 测试项：',
    tests,
    '',
  ].join('\n')
}

const selected = inventory.items.filter(item => item.domain === 'other' || item.hasSkip)
const output = [
  '# 测试清单详细测试项',
  '',
  '> 由 `scripts/tests/generate-test-details.mjs` 根据测试源码生成。用于 Phase 0 人工复核职责、内容和潜在重复，不替代运行器实际收集结果。',
  '',
  `- 清单来源：\`docs/reports/2026-08-31-TEST-INVENTORY.json\``,
  `- 条目数：${selected.length}`,
  '',
  ...selected.map(detail),
].join('\n')

fs.writeFileSync(outputPath, `${output}\n`)
console.log(`已生成 ${path.relative(root, outputPath)}，共 ${selected.length} 个条目。`)
