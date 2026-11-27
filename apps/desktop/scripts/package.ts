import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, existsSync, lstatSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const desktop = fileURLToPath(new URL('../', import.meta.url)),
  root = resolve(desktop, '../..')
const require = createRequire(import.meta.url),
  pnpm = process.env.npm_execpath
if (!pnpm || !existsSync(pnpm)) throw new Error('请通过 pnpm run build 装配桌面制品')
const options = process.argv.slice(2).filter((option) => option !== '--')
if (options.some((item) => !['--dir', '--mac', '--win', '--x64', '--arm64'].includes(item)))
  throw new Error('不支持的桌面构建参数')
const feed = process.env.GUGU_DESKTOP_UPDATE_URL
const releaseOptions: string[] = []
if (feed) {
  const url = new URL(feed)
  const platform = options.includes('--mac') ? 'darwin' : options.includes('--win') ? 'win32' : undefined
  const arch = options.includes('--arm64') ? 'arm64' : options.includes('--x64') ? 'x64' : undefined
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !platform || !arch || options.length !== 2)
    throw new Error('更新制品需要 HTTPS 更新根地址及单一平台和架构')
  const base = url.href.replace(/\/+$/, '')
  releaseOptions.push('--config.publish.provider=generic', `--config.publish.url=${base}/stable/${platform}-${arch}/`,
    `--config.directories.output=release/${platform}-${arch}`, '--config.forceCodeSigning=true')
  if (platform === 'darwin') {
    const identity = process.env.GUGU_DESKTOP_MAC_SIGN_IDENTITY
    if (!identity || identity === '-') throw new Error('更新制品需要正式 macOS 签名身份')
    releaseOptions.push(`--config.mac.identity=${identity}`, '--config.mac.hardenedRuntime=true')
  } else {
    const publisher = process.env.GUGU_DESKTOP_WIN_PUBLISHER
    if (!publisher) throw new Error('更新制品需要 Windows 签名发布者')
    releaseOptions.push('--config.win.signExecutable=true', `--config.win.publisherName=${publisher}`)
  }
}
const node = process.execPath
const run = (script: string, args: string[] = []) =>
  execFileSync(node, [script, ...args], { cwd: desktop, stdio: 'inherit' })
run(join(desktop, 'scripts/prepare-sidecar.mjs'))
run(join(desktop, 'scripts/build.mjs'))
run(pnpm, ['--filter', 'gugu-web', 'build:desktop'])
run(join(desktop, 'scripts/smoke-sidecar.mjs'))
const staging = resolve(desktop, '.tools')
mkdirSync(staging, { recursive: true })
const stage = mkdtempSync(join(staging, 'electron-app-'))
try {
  run(pnpm, [
    '--filter',
    'gugu-desktop',
    'deploy',
    '--prod',
    '--legacy',
    '--config.node-linker=hoisted',
    stage,
  ])
  cpSync(resolve(root, 'apps/ui/dist-desktop'), join(stage, 'ui'), {
    recursive: true,
  })
  buildSync({
    entryPoints: [join(root, 'packages/cli/src/bin.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(stage, 'dist', 'cli', 'gugu.cjs'),
  })
  cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
  // 打包前重新生成 macOS 图标，保证 icns 与主图标一致且结构规范。
  run(join(desktop, 'scripts/build-icons.mjs'))
  run(require.resolve('electron-builder/cli.js'), [
    '--config',
    join(desktop, 'electron-builder.yml'),
    `--config.directories.app=${stage}`,
    '--publish',
    'never',
    ...releaseOptions,
    ...options,
  ])
} finally {
  if (!stage.startsWith(staging + sep) || lstatSync(stage).isSymbolicLink())
    throw new Error('构建暂存目录超出预期范围')
  rmSync(stage, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}
