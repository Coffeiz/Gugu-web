import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const host = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(host, '../..')
const required = ['packages/core/dist/agent/skills/bundled.js', 'packages/fs/dist/node.js', 'packages/gateway/dist/index.js', 'packages/sandbox/dist/contracts.js', 'packages/database/dist/postgres/migrate.js']
const missing = required.filter(path => !existsSync(resolve(root, path)))
if (missing.length) {
  console.error('开发依赖制品尚未初始化，请先执行：corepack pnpm --filter @gugu/core build && corepack pnpm --filter @gugu/fs build && corepack pnpm --filter @gugu/gateway build')
  process.exit(1)
}

const children = new Set()
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  process.exitCode = code
}
function start(label, args) {
  const child = spawn(process.execPath, args, { cwd: host, stdio: 'inherit', env: process.env })
  children.add(child)
  child.on('error', error => { console.error(`${label} 启动失败：`, error.message); stop(1) })
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (!stopping) { console.error(`${label} 已退出（${code ?? signal}）`); stop(code || 1) }
  })
}
const tsc = resolve(host, 'node_modules/typescript/bin/tsc')
for (const name of ['sandbox', 'database', 'core', 'fs', 'gateway']) {
  const project = resolve(root, `packages/${name}`)
  start(`${name} 监听`, [tsc, '-p', project, '--watch', '--preserveWatchOutput', '--incremental', '--tsBuildInfoFile', resolve(project, 'dist/.dev.tsbuildinfo'), '--noEmitOnError'])
}
const tsx = resolve(host, 'node_modules/tsx/dist/cli.mjs')
start('Web Host 监听', [tsx, 'watch', '--clear-screen=false', ...['sandbox', 'database', 'core', 'fs', 'gateway'].flatMap(name => ['--include', resolve(root, `packages/${name}/dist/**/*.js`)]), 'src/main.ts'])
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
