import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const web = resolve(desktop, '../web')
const viteCli = resolve(web, 'node_modules/vite/bin/vite.js')
const electronCli = resolve(desktop, 'node_modules/electron/cli.js')
const required = [
  resolve(desktop, 'dist/main/index.cjs'),
  resolve(desktop, 'dist/preload/index.cjs'),
  resolve(desktop, 'resources/core-sidecar/manifest.json'),
]

if (!existsSync(viteCli) || !existsSync(electronCli)) throw new Error('桌面开发依赖未安装')
if (required.some((path) => !existsSync(path))) {
  console.error('桌面运行产物缺失。首次运行请先执行 npm run dev:prepare。')
  process.exit(1)
}

const port = 5176
const devUrl = `http://127.0.0.1:${port}/desktop.html?desktopPreview=1`
const vite = spawn(process.execPath, [viteCli, '--config', 'vite.desktop.config.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: web,
  stdio: 'inherit',
  env: process.env,
})
let electron
let stopping = false

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

function stop(code = 0) {
  if (stopping) return
  stopping = true
  if (electron && electron.exitCode === null) electron.kill('SIGTERM')
  if (vite.exitCode === null) vite.kill('SIGTERM')
  process.exitCode = code
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
vite.on('exit', (code) => {
  if (!stopping && electron?.exitCode === null) stop(code ?? 1)
})

try {
  await waitForVite()
  console.log(`桌面 UI 热更新地址：${devUrl}`)
  const electronEnv = { ...process.env, GUGU_DESKTOP_DEV_URL: devUrl }
  // Node 的代理 CA 参数被 Electron 运行时拒绝；它只对包管理器下载有用。
  if (electronEnv.NODE_OPTIONS?.includes('--use-bundled-ca')) {
    electronEnv.NODE_OPTIONS = electronEnv.NODE_OPTIONS
      .replace(/(?:^|\s)--use-bundled-ca(?=\s|$)/g, '')
      .trim()
  }
  electron = spawn(process.execPath, [electronCli, '.'], {
    cwd: desktop,
    stdio: 'inherit',
    env: electronEnv,
  })
  electron.on('exit', (code) => stop(code ?? 0))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  stop(1)
}
