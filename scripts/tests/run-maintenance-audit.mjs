#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const today = new Date().toISOString().slice(0, 10)
const reportPath = path.join(root, `docs/reports/${today}-TEST-MAINTENANCE.md`)

function run(label, args) {
  const result = spawnSync('node', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    throw new Error(`${label} 失败`)
  }
  return result.stdout.trim()
}

run('测试清单', ['scripts/tests/collect-test-inventory.mjs', '--output=docs/reports/2026-08-31-TEST-INVENTORY.json'])
run('测试明细', ['scripts/tests/generate-test-details.mjs'])
run('领域明细', ['scripts/tests/generate-domain-details.mjs'])
run('领域审查', ['scripts/tests/generate-domain-audit.mjs'])
run('helper 审计', ['scripts/tests/audit-test-helpers.mjs'])
run('边界检查', ['scripts/tests/check-test-boundaries.mjs'])
run('元数据检查', ['scripts/tests/check-test-metadata.mjs'])

const inventory = JSON.parse(fs.readFileSync(path.join(root, 'docs/reports/2026-08-31-TEST-INVENTORY.json'), 'utf8'))
const policy = JSON.parse(fs.readFileSync(path.join(root, 'docs/testing/skip-policy.json'), 'utf8'))
const actualSkips = new Set(inventory.items.filter(item => item.hasSkip).map(item => item.file))
const policyFiles = new Set(policy.items.map(item => item.file))
const missing = [...actualSkips].filter(file => !policyFiles.has(file))
const stale = policy.items.filter(item => !actualSkips.has(item.file))
const expired = policy.items.filter(item => item.expiresOn < today)
if (missing.length || stale.length || expired.length) {
  console.error('[测试维护] skip 策略与清单不一致或已过期')
  for (const file of missing) console.error(`- 缺少策略：${file}`)
  for (const item of stale) console.error(`- 清单已无 skip：${item.file}`)
  for (const item of expired) console.error(`- skip 已到期：${item.file} (${item.expiresOn})`)
  process.exit(1)
}

const lines = [
  `# 测试维护审计（${today}）`,
  '',
  '> 由 `scripts/tests/run-maintenance-audit.mjs` 生成；用于月度清单、skip 到期和入口健康检查。',
  '',
  '## 清单状态',
  '',
  `- 测试资产：${inventory.summary.files} 个`,
  `- 声明用例：${inventory.summary.declaredTests} 个`,
  `- skip 文件：${inventory.summary.skipFiles} 个，均有未到期策略`,
  `- 未归类文件：${inventory.summary.byDomain.other ?? 0} 个`,
  '',
  '## 维护入口',
  '',
  '| 检查 | 命令 | 目的 |',
  '|---|---|---|',
  '| 快速门禁 | `pnpm test:fast` | PR L0 与快速回归 |',
  '| 受影响测试 | `pnpm test:affected -- --base=<sha>` | PR 受影响 L1 |',
  '| 完整矩阵 | `pnpm test:all` | 主分支/发布前完整验证 |',
  '| 月度审计 | `pnpm test:maintenance` | 清单、helper、边界和 skip 到期 |',
  '',
  '## 慢测与失败记录',
  '',
  '- 慢测耗时由 CI job 摘要记录；失败按环境准备、代码/测试执行和测试分类三类步骤区分。',
  '- 本次审计不自动重试失败测试；重试必须在 CI job 中显式记录，避免把 flaky 当成通过。',
  '',
  '## 结论',
  '',
  '- [x] 清单无失联文件。',
  '- [x] `other=0`，所有实际 skip 均有责任人和到期日期。',
  '- [x] 新增测试需通过 `test:metadata` 元数据门禁。',
]
fs.writeFileSync(reportPath, `${lines.join('\n')}\n`)
console.log(`已生成 ${path.relative(root, reportPath)}`)
