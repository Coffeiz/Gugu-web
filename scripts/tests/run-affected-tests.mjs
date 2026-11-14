#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const backend = path.join(root, 'backend')
const python = process.env.GUGU_TEST_PYTHON || path.join(backend, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const baseArg = process.argv.find(arg => arg.startsWith('--base='))?.slice('--base='.length)

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function run(label, command, args, cwd, env = {}) {
  if (command === 'pnpm' && process.env.npm_execpath && process.env.npm_config_user_agent?.startsWith('pnpm/')) { args = [process.env.npm_execpath, ...args]; command = process.execPath }
  if (command === 'node') command = process.execPath
  console.log(`[受影响测试] ${label}`)
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'pnpm',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

let base = baseArg || process.env.GITHUB_BASE_SHA || 'HEAD'
if (!baseArg && !process.env.GITHUB_BASE_SHA) {
  try { base = git(['merge-base', 'HEAD', 'main']) } catch { base = 'HEAD' }
}

let changed
try {
  changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean)
} catch {
  changed = git(['diff', '--name-only', base]).split('\n').filter(Boolean)
}

if (!changed.length) {
  console.log('[受影响测试] 没有相对基线的变更，跳过 L1 定向测试')
  process.exit(0)
}

const inventoryPath = path.join(root, 'docs/reports/2026-08-31-TEST-INVENTORY.json')
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'))
const backendChanged = changed.some(file => file.startsWith('backend/'))
const frontendChanged = changed.some(file => file.startsWith('apps/web/'))
const runtimeChanged = changed.some(file => file.startsWith('loopscope/') || file.startsWith('backend/ts/'))
const fsChanged = changed.some(file => file.startsWith('packages/fs/'))
const coreChanged = changed.some(file => /^(packages\/(?:core|sandbox)\/|compat\/core-python\/|scripts\/tests\/|pnpm-lock\.yaml|pnpm-workspace\.yaml)/.test(file))
const desktopChanged = changed.some(file => /^(apps\/desktop\/|apps\/web\/src\/desktop\/)/.test(file))

if (fsChanged) run('共享 FS 回归', 'pnpm', ['--filter', '@gugu/fs', 'test'], root)
if (coreChanged || desktopChanged) {
  run('Node Core 受影响快速回归', 'pnpm', ['--filter', '@gugu/core', 'test:unit'], root)
  run('Node Core 受影响进程回归', 'pnpm', ['--filter', '@gugu/core', 'test:ipc'], root)
}
if (desktopChanged) run('Electron Host 受影响回归', 'pnpm', ['--filter', 'gugu-desktop', 'test'], root)

if (backendChanged) {
  const targets = inventory.items
    .filter(item => item.kind === 'pytest' && item.layer === 'L1')
    .map(item => item.file.replace(/^backend\//, ''))
  if (targets.length) {
    run('后端受影响 L1（按领域快照执行）', python, ['-m', 'pytest', '-q', ...targets], backend, { PYTHONPATH: '.' })
  }
}

if (frontendChanged) {
  run('前端受影响 L0/L1', 'pnpm', ['--filter', 'gugu-web', 'run', 'test:run'], root)
}

if (runtimeChanged) {
  run('LoopScope/Runtime 受影响测试', 'pnpm', ['--dir', 'loopscope', 'test'], root)
}

console.log('[受影响测试] 完成')
