#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const backend = path.join(root, 'backend')
const frontend = path.join(root, 'frontend')
const python = path.join(backend, '.venv/bin/python')
const args = new Set(process.argv.slice(2))

function run(label, command, commandArgs, cwd, env = {}) {
  console.log(`[测试分层] ${label}`)
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function backendPytest(label, marker) {
  run(label, python, ['-m', 'pytest', '-q', '-m', marker], backend, { PYTHONPATH: '.' })
}

const tier = process.env.TEST_TIER ?? process.argv.find(arg => !arg.startsWith('-'))
if (!['unit', 'integration', 'e2e', 'all'].includes(tier)) {
  console.error('用法：TEST_TIER=unit|integration|e2e|all node scripts/tests/run-test-tier.mjs [--skip-e2e]')
  process.exit(2)
}

if (tier === 'unit' || tier === 'all') {
  backendPytest('后端 L0/L1 单元测试', 'not slow and not external_service and not process and not e2e_support')
  run('前端单元测试', 'npm', ['run', 'test:run'], frontend)
}

if (tier === 'integration' || tier === 'all') {
  backendPytest('后端集成与外部边界测试', 'slow or external_service or process or e2e_support')
}

if (tier === 'e2e' || (tier === 'all' && !args.has('--skip-e2e'))) {
  run('稳定 E2E', 'npm', ['run', 'test:e2e:stable'], frontend)
}

if (tier === 'all') {
  run('前端类型检查', 'npm', ['run', 'typecheck'], frontend)
  run('前端严格类型检查', 'npm', ['run', 'typecheck:strict'], frontend)
  run('前端构建', 'npm', ['run', 'build'], frontend)
  run('前端 i18n 检查', 'npm', ['run', 'i18n:scan'], frontend)
  run('前端 CSS 回归检查', 'npm', ['run', 'test:css-glass'], frontend)
  run('前端弹窗回归检查', 'npm', ['run', 'test:ui-dialogs'], frontend)
  run('测试资产边界检查', 'node', ['scripts/tests/check-test-boundaries.mjs'], root)
}

console.log(`[测试分层] ${tier} 通过`)
