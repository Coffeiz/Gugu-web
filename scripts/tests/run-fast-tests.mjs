#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const python = process.env.GUGU_TEST_PYTHON || path.join(root, process.platform === 'win32' ? 'backend/.venv/Scripts/python.exe' : 'backend/.venv/bin/python')

function run(label, command, args, cwd) {
  if (command === 'pnpm' && process.env.npm_execpath && process.env.npm_config_user_agent?.startsWith('pnpm/')) { args = [process.env.npm_execpath, ...args]; command = process.execPath }
  if (command === 'node') command = process.execPath
  console.log(`[快速门禁] ${label}`)
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'pnpm',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('共享 FS 回归', 'pnpm', ['--filter', '@gugu/fs', 'test'], root)
run('Node Core 快速隔离回归', 'pnpm', ['--filter', '@gugu/core', 'test:unit'], root)
run('Python compileall', python, ['-m', 'compileall', '-q', 'app', 'agent'], path.join(root, 'backend'))
run('ownership 守卫', python, ['scripts/checks/check_ownership.py'], path.join(root, 'backend'))
run('确认门守卫', python, ['scripts/checks/check_confirm_gate.py'], path.join(root, 'backend'))
run('Agent ORM 严格守卫', python, [
  'scripts/checks/check_orm_boundaries.py',
  '--agent-strict',
], path.join(root, 'backend'))
run('文件同步 TS watcher 依赖', 'pnpm', [
  'install',
  '--filter',
  '@gugu/filesync-watcher...',
  '--frozen-lockfile',
], root)
run(
  '后端快速 pytest',
  python,
  ['-m', 'pytest', '-q', '-m', 'not slow and not external_service and not process and not e2e_support'],
  path.join(root, 'backend'),
)
run('前端 L0 Vitest', 'pnpm', ['--filter', 'gugu-web', 'run', 'test:fast'], root)
run('前端 i18n 静态检查', 'pnpm', ['--filter', 'gugu-web', 'run', 'i18n:scan'], root)
run('前端对话框静态检查', 'pnpm', ['--filter', 'gugu-web', 'run', 'test:ui-dialogs'], root)

console.log('[快速门禁] 全部通过')
