import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDesktopAgentRuntime } from './build-agent-runtime.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
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
await buildDesktopAgentRuntime()
