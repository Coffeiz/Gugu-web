import { existsSync, watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const host = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(host, '../..')
const tsc = resolve(host, 'node_modules/typescript/bin/tsc')
const packages = ['sandbox', 'database', 'fs', 'core', 'gateway']
const manifests = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']
const hostArgs = ['--import', 'tsx', 'src/main.ts']
const watchers = []
let runningHost
let build
let timer
let stopping = false
let rebuilding = false
let revision = 0
let installNeeded = true
let sharedBuildNeeded = true
let skillsBuildNeeded = true

function launch(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' })
  const exited = new Promise((finish, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => finish({ code, signal }))
  })
  return { child, exited }
}

async function run(label, args, { command = process.execPath, cwd = host } = {}) {
  if (stopping) throw new Error('开发监听已停止')
  const task = launch(command, args, cwd)
  build = task
  try {
    const { code, signal } = await task.exited
    if (code !== 0) throw new Error(`${label}失败（${code ?? signal}）`)
  } finally { build = undefined }
}

async function prepare() {
  if (installNeeded) {
    await run('开发依赖安装', ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], { command: 'corepack', cwd: root })
  }
  if (sharedBuildNeeded) {
    await run('图表包检查', [resolve(root, 'packages/charts/scripts/build.mjs')])
    for (const name of packages) {
      const project = resolve(root, 'packages', name)
      await run(`${name} 编译`, [tsc, '-p', project, '--incremental', '--noEmitOnError',
        '--tsBuildInfoFile', resolve(project, 'dist/.dev.tsbuildinfo')])
    }
  }
  if (skillsBuildNeeded || !existsSync(resolve(root, 'packages/core/dist/agent/skills/bundled.js'))) {
    await run('内置技能编译', [resolve(root, 'packages/core/scripts/build-skills.mjs')])
  }
  await run('Web Host 类型检查', [tsc, '-p', 'tsconfig.build.json', '--noEmit', '--incremental',
    '--tsBuildInfoFile', 'dist/.dev-check.tsbuildinfo'])
  await run('Web Host 模块检查', ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/main.ts')"])
}

/** 首先完成安装和编译。编译中新增的变更要重新检查后才能切换进程。 */
async function rebuild() {
  if (stopping || rebuilding) return
  const target = revision
  rebuilding = true
  try {
    await prepare()
    if (stopping || revision !== target) return
    if (runningHost) {
      runningHost.child.kill('SIGTERM')
      await runningHost.exited
    }
    if (stopping || revision !== target) return
    installNeeded = sharedBuildNeeded = skillsBuildNeeded = false
    const next = launch(process.execPath, hostArgs, host)
    runningHost = next
    void next.exited.then(({ code, signal }) => {
      if (!stopping && runningHost === next && !rebuilding)
        console.error(`Web Host 已退出（${code ?? signal}），等待下一次源码变更`)
    }, error => {
      if (!stopping) console.error('Web Host 启动失败：', error.message)
    }).finally(() => { if (runningHost === next) runningHost = undefined })
    console.log('开发检查通过，已启动 Web Host')
  } catch (error) {
    if (!stopping) console.error(`${error.message}，保留当前 Web Host，等待下一次源码变更`)
  } finally {
    rebuilding = false
    if (revision !== target) schedule()
  }
}

function schedule() {
  if (stopping) return
  clearTimeout(timer)
  timer = setTimeout(() => void rebuild(), 500)
}

function changed({ install = false, shared = false, skills = false } = {}) {
  revision++
  installNeeded ||= install
  sharedBuildNeeded ||= shared || install
  skillsBuildNeeded ||= skills || shared || install
  schedule()
}

function observe(directory, recursive, accept, flags) {
  if (!existsSync(directory)) return
  const watcher = watch(directory, { recursive }, (_event, file) => {
    if (!file || accept(file)) changed(flags)
  })
  watcher.on('error', error => console.error('开发文件监听失败：', error.message))
  watchers.push(watcher)
}

const isSource = file => /\.(?:[cm]?[jt]s|json|md|sql)$/u.test(file)
observe(root, false, file => manifests.includes(file), { install: true })
observe(host, false, file => file === 'package.json' || /^tsconfig.*\.json$/.test(file), { install: true })
for (const path of ['src', 'assets']) observe(resolve(host, path), true, isSource)
for (const name of [...packages, 'charts', 'log', 'loopscope']) {
  const project = resolve(root, 'packages', name)
  observe(project, false, file => file === 'package.json', { install: true })
  observe(project, false, file => /^tsconfig.*\.json$/.test(file) || name === 'loopscope' && /^(?:index|trace)\./.test(file), { shared: true })
  for (const path of ['src', 'resources', 'scripts']) observe(resolve(project, path), true, isSource, { shared: true })
}

function stop() {
  if (stopping) return
  stopping = true
  clearTimeout(timer)
  for (const watcher of watchers) watcher.close()
  build?.child.kill('SIGTERM')
  runningHost?.child.kill('SIGTERM')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
void rebuild()
