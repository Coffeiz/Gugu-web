import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDesktopAgentRuntime } from './build-agent-runtime.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))

async function acquireBuildLock() {
  const lockDirectory = resolve(root, '.tools')
  const lockPath = resolve(lockDirectory, 'desktop-build.lock')
  const token = randomUUID()
  await mkdir(lockDirectory, { recursive: true })
  const deadline = Date.now() + 10 * 60_000
  let announced = false
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
      await handle.close()
      const release = () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, 'utf8'))
          if (current.token === token) unlinkSync(lockPath)
        } catch { /* 锁已由异常退出恢复流程清理。 */ }
      }
      process.once('exit', release)
      return () => { process.removeListener('exit', release); release() }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const lock = JSON.parse(await readFile(lockPath, 'utf8'))
        let ownerAlive = true
        try { process.kill(lock.pid, 0) }
        catch (probeError) { if (probeError?.code === 'ESRCH') ownerAlive = false }
        if (!ownerAlive) {
          await unlink(lockPath).catch(unlinkError => { if (unlinkError?.code !== 'ENOENT') throw unlinkError })
          continue
        }
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') continue
        const details = await stat(lockPath).catch(() => null)
        if (details && Date.now() - details.mtimeMs > 60_000)
          await unlink(lockPath).catch(unlinkError => { if (unlinkError?.code !== 'ENOENT') throw unlinkError })
      }
      if (!announced) {
        console.log('桌面构建入口正在被其他构建使用，等待其完成')
        announced = true
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
    }
  }
  throw new Error('等待桌面构建锁超时，请检查是否有未结束的构建进程')
}

const releaseBuildLock = await acquireBuildLock()
try {
const gmailClientId = process.env.GUGU_GMAIL_OAUTH_CLIENT_ID?.trim()
const gmailClientSecret = process.env.GUGU_GMAIL_OAUTH_CLIENT_SECRET?.trim()
// 桌面 OAuth 客户端属于公开客户端，打包配置只进入 Electron 主进程。
const gmailOAuthDefines = gmailClientId ? {
  'process.env.GUGU_GMAIL_OAUTH_CLIENT_ID': JSON.stringify(gmailClientId),
  'process.env.GUGU_GMAIL_OAUTH_CLIENT_SECRET': JSON.stringify(gmailClientSecret ?? ''),
} : {}
for (const entry of ['main', 'preload']) {
  await build({
    entryPoints: [resolve(root, `src/${entry}/index.ts`)],
    outfile: resolve(root, `dist/${entry}/index.cjs`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    ...(entry === 'main' ? {
      banner: { js: 'const guguMainModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
      define: { 'import.meta.url': 'guguMainModuleUrl', ...gmailOAuthDefines },
    } : {}),
    // unzipper 仅在 Open.s3 内延迟加载 AWS SDK，桌面只调用 Open.file / Open.buffer。
    external: ['electron', 'electron-updater', '@node-rs/jieba', '@aws-sdk/client-s3'],
    sourcemap: true,
  })
}
await build({
  entryPoints: [resolve(root, 'src/preload/chat-fab.ts')],
  outfile: resolve(root, 'dist/preload/chat-fab.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
})
await build({
  entryPoints: {
    qq: resolve(root, 'src/main/im/gateway/platforms/qq/connection-child.ts'),
    platforms: resolve(root, 'src/main/im/gateway/process-child.ts'),
  },
  outdir: resolve(root, 'dist/gateway'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  banner: { js: 'const guguGatewayModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': 'guguGatewayModuleUrl' },
  external: ['@node-rs/jieba', '@aws-sdk/client-s3'],
})

if (process.platform === 'darwin') {
  const nativeDir = resolve(root, 'dist/native')
  await mkdir(nativeDir, { recursive: true })
  execFileSync('xcrun', ['clang++', '-bundle', '-fobjc-arc', '-undefined', 'dynamic_lookup',
    '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.5',
    '-framework', 'AppKit', '-I', resolve(dirname(process.execPath), '../include/node'),
    resolve(root, 'native/macos/chat-fab-glass.mm'), '-o', resolve(nativeDir, 'chat-fab-glass.node')],
  { stdio: 'inherit' })
}
await copyFile(resolve(root, '../../packages/core/src/agent/subagent/searcher/prompt.md'), resolve(root, 'dist/main/prompt.md'))
await copyFile(resolve(root, '../../packages/core/src/agent/subagent/searcher/prompt.md'), resolve(root, 'dist/gateway/prompt.md'))
await buildDesktopAgentRuntime()
} finally {
  releaseBuildLock()
}
