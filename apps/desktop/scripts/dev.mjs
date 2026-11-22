import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch } from 'node:fs'
import { request } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { prepareDesktopPty } from './prepare-pty.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ui = resolve(desktop, '../ui')
const viteCli = resolve(ui, 'node_modules/vite/bin/vite.js')
const electronCli = resolve(desktop, 'node_modules/electron/cli.js')
const root = resolve(desktop, '../..')
const tsc = resolve(desktop, 'node_modules/typescript/bin/tsc')
const compiledPackages = ['sandbox', 'database', 'fs', 'gateway', 'core']
const hostOutputs = [
  resolve(desktop, 'dist/main/index.cjs'),
  resolve(desktop, 'dist/preload/index.cjs'),
  resolve(desktop, '.tools/agent/runtime.mjs'),
]

if (!existsSync(viteCli) || !existsSync(electronCli) || !existsSync(tsc))
  throw new Error('桌面开发依赖未安装')

prepareDesktopPty(resolve(root, 'packages/core/package.json'))

const preferredPort = 5176
const lastPort = 5190

async function findAvailablePort() {
  for (let candidate = preferredPort; candidate <= lastPort; candidate += 1) {
    const server = createServer()
    try {
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(candidate, '127.0.0.1', resolvePromise)
      })
      await new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise())
      })
      return candidate
    } catch (error) {
      if (server.listening) server.close()
      if (error?.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`桌面开发端口 ${preferredPort}-${lastPort} 均被占用，请关闭不需要的开发服务后重试`)
}

const port = await findAvailablePort()
const previewPath = '/desktop.html?desktopPreview=1'
const devUrl = `http://127.0.0.1:${port}${previewPath}`
const bridgeDirectory = mkdtempSync(resolve(tmpdir(), 'gugu-'))
const bridge = {
  GUGU_DESKTOP_PREVIEW_SOCKET: process.platform === 'win32'
    ? String.raw`\\.\pipe\gugu-${randomBytes(16).toString('hex')}`
    : resolve(bridgeDirectory, 'agent.sock'),
  GUGU_DESKTOP_PREVIEW_SECRET: randomBytes(32).toString('hex'),
}
process.once('exit', () => rmSync(bridgeDirectory, { recursive: true, force: true }))
const viteArgs = [viteCli, '--config', 'vite.desktop.config.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
if (process.argv.includes('--open')) viteArgs.push('--open', previewPath)
const vite = spawn(process.execPath, viteArgs, {
  cwd: ui,
  stdio: 'inherit',
  env: { ...process.env, ...bridge },
})
let electron
let stopping = false
let restarting = false
let builder
let timer
let rebuilding = false
let pending = 0
const watchers = []

async function waitForVite() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error('Vite 开发服务器提前退出')
    try {
      const response = await fetch(devUrl)
      if (response.ok) return
    } catch { /* Vite 正在启动 */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  throw new Error('等待 Vite 开发服务器超时')
}

async function waitForDesktopPreview() {
  const deadline = Date.now() + 20_000
  while (!stopping && Date.now() < deadline) {
    const ready = await new Promise(resolveReady => {
      const socket = createConnection(bridge.GUGU_DESKTOP_PREVIEW_SOCKET)
      socket.once('connect', () => { socket.destroy(); resolveReady(true) })
      socket.once('error', () => resolveReady(false))
    })
    if (ready) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
  }
  if (!stopping) throw new Error('等待桌面预览连接超时')
}

function stop(code = 0) {
  if (stopping) return
  stopping = true
  clearTimeout(timer)
  for (const watcher of watchers) watcher.close()
  builder?.kill('SIGTERM')
  if (electron && electron.exitCode === null) electron.kill('SIGTERM')
  if (vite.exitCode === null) vite.kill('SIGTERM')
  process.exitCode = code
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
vite.on('exit', (code) => {
  if (!stopping) stop(code || 1)
})

const electronEnv = { ...process.env, ...bridge, GUGU_DESKTOP_DEV_URL: devUrl, GUGU_DESKTOP_DEV_NODE: process.execPath }
// Node 的代理 CA 参数只用于包管理器下载。
electronEnv.NODE_OPTIONS = electronEnv.NODE_OPTIONS?.replace(/(?:^|\s)--use-bundled-ca(?=\s|$)/g, '').trim()

function launchElectron() {
  electron = spawn(process.execPath, [electronCli, '.'], { cwd: desktop, stdio: 'inherit', env: electronEnv })
  electron.on('error', error => { console.error(error.message); stop(1) })
  electron.on('exit', code => { if (!restarting) stop(code ?? 0) })
}

async function runBuild(args) {
  if (stopping) return
  builder = spawn(process.execPath, args, { cwd: desktop, stdio: 'inherit' })
  const [code] = await once(builder, 'exit').finally(() => { builder = undefined })
  if (code !== 0) throw new Error('桌面构建失败')
}

async function buildWorkspace() {
  for (const name of compiledPackages) {
    const project = resolve(root, 'packages', name)
    await runBuild([tsc, '-p', project, '--incremental', '--noEmitOnError',
      '--tsBuildInfoFile', resolve(project, 'dist/.desktop-dev.tsbuildinfo')])
  }
  await runBuild([resolve(root, 'packages/core/scripts/build-skills.mjs')])
}

function hostFingerprint() {
  const hash = createHash('sha256')
  for (const path of hostOutputs) hash.update(readFileSync(path))
  return hash.digest('hex')
}

function reloadRuntime(target) {
  return new Promise((resolveReload, reject) => {
    const req = request({
      socketPath: bridge.GUGU_DESKTOP_PREVIEW_SOCKET,
      path: `/__desktop-preview/reload${target === 'core' ? '-core' : ''}`,
      method: 'POST',
      headers: { Authorization: bridge.GUGU_DESKTOP_PREVIEW_SECRET, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    }, res => {
      res.resume()
      if (res.statusCode === (target === 'core' ? 204 : 202)) resolveReload()
      else reject(new Error('桌面进程未能重载运行时'))
    })
    req.once('error', reject)
    req.end()
  })
}

async function restartElectron() {
  await waitForVite()
  if (stopping) return
  restarting = true
  try {
    const exited = once(electron, 'exit', { signal: AbortSignal.timeout(30_000) })
    await Promise.all([reloadRuntime('electron'), exited])
    if (stopping) return
    await waitForVite()
    if (stopping) return
    launchElectron()
    restarting = false
    await waitForDesktopPreview()
    if (!stopping) console.log('Electron 已自动重载')
  } finally { restarting = false }
}

async function rebuild() {
  if (stopping || rebuilding || !pending) return
  rebuilding = true
  try {
    const level = pending
    pending = 0
    console.log(level === 2 ? '检测到共享包改动，正在重建桌面 Core' : '检测到宿主改动，正在重建 Electron')
    const previousHost = hostFingerprint()
    try {
      if (level === 2) await buildWorkspace()
      await runBuild([resolve(desktop, 'scripts/build.mjs')])
    }
    catch (error) {
      if (!stopping) console.error(error.message + '，保留当前桌面进程，等待下次修改')
      return
    }
    if (stopping) return
    if (previousHost !== hostFingerprint()) await restartElectron()
    else if (level === 2) {
      await reloadRuntime('core')
      console.log('桌面 Core 已自动重载')
    }
  } catch (error) {
    if (!stopping) console.error('桌面重载失败：' + error.message)
    if (electron.exitCode !== null || electron.signalCode !== null) stop(1)
  } finally {
    rebuilding = false
    if (pending && !stopping) scheduleBuild(pending)
  }
}

function scheduleBuild(level) {
  pending = Math.max(pending, level)
  clearTimeout(timer)
  timer = setTimeout(() => void rebuild(), 300)
}

const sourceExtension = /\.(?:[cm]?[jt]s|json|md|sql|rs|toml|cpp|h)$/u

function sourceFingerprint(directory) {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(file => file.isFile() && sourceExtension.test(file.name))
    .map(file => resolve(file.parentPath, file.name))
    .sort()
  const hash = createHash('sha256')
  for (const file of files) {
    try {
      const content = readFileSync(file)
      hash.update(file).update('\0').update(String(content.length)).update('\0').update(content)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return hash.digest('hex')
}

function watchSource(path, level) {
  if (!existsSync(path)) return
  let fingerprint = sourceFingerprint(path)
  const watcher = watch(path, { recursive: true }, (_event, file) => {
    if (file && !sourceExtension.test(file)) return
    try {
      // 打包可能刷新文件元数据，内容相同的事件不触发下一次构建。
      const current = sourceFingerprint(path)
      if (current === fingerprint) return
      fingerprint = current
      scheduleBuild(level)
    } catch (error) {
      if (!stopping) console.error('检查桌面源码变更失败：' + error.message)
    }
  })
  watcher.on('error', error => console.error('桌面源码监听失败：' + error.message))
  watchers.push(watcher)
}

try {
  await buildWorkspace()
  await runBuild([resolve(desktop, 'scripts/build.mjs')])
  await waitForVite()
  if (!stopping) {
    // 提前打印：Electron 启动横幅和 Vite 输出会淹没这行，浏览器预览地址要一眼可见。
    if (port !== preferredPort) console.log(`端口 ${preferredPort} 已被占用，改用 ${port}`)
    console.log(`\n  桌面共享预览地址（与 Electron 共用模型、IM 和会话）\n  → ${devUrl}\n`)
    launchElectron()
  }
  await waitForDesktopPreview()
  if (!stopping) {
    for (const source of ['main', 'preload'])
      watchSource(resolve(desktop, 'src', source), 1)
    watchSource(resolve(root, 'packages/desktop-contracts/src'), 1)
    for (const pkg of ['core', 'database', 'fs', 'gateway', 'log', 'loopscope', 'sandbox', 'charts']) {
      const directory = resolve(desktop, '../../packages', pkg)
      if (pkg === 'loopscope') watchSource(directory, 2)
      else for (const source of ['src', 'native', 'resources']) watchSource(resolve(directory, source), 2)
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  stop(1)
}
