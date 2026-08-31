#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const python = path.join(root, 'backend/.venv/bin/python')

function run(label, command, args, cwd) {
  console.log(`[快速门禁] ${label}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('Python compileall', python, ['-m', 'compileall', '-q', 'app', 'agent'], path.join(root, 'backend'))
run('ownership 守卫', python, ['scripts/check_ownership.py'], path.join(root, 'backend'))
run('确认门守卫', python, ['scripts/check_confirm_gate.py'], path.join(root, 'backend'))
run('Agent ORM 严格边界守卫', python, ['scripts/check_orm_boundaries.py', '--agent-strict'], path.join(root, 'backend'))
run(
  '后端快速 pytest',
  python,
  ['-m', 'pytest', '-q', '-m', 'not slow and not external_service and not process and not e2e_support'],
  path.join(root, 'backend'),
)
run('前端 L0 Vitest', 'npm', ['run', 'test:fast'], path.join(root, 'frontend'))
run('前端 i18n 静态检查', 'npm', ['run', 'i18n:scan'], path.join(root, 'frontend'))
run('前端对话框静态检查', 'npm', ['run', 'test:ui-dialogs'], path.join(root, 'frontend'))

console.log('[快速门禁] 全部通过')
