import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, existsSync, lstatSync, readdirSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { configureWindowsInstaller } from '../../installer/windows/build.ts'
import { fingerprintPaths, workspaceFingerprintPaths } from './cache.ts'

const desktop = fileURLToPath(new URL('../..', import.meta.url)),
  root = resolve(desktop, '../..')
const require = createRequire(import.meta.url),
  pnpm = process.env.npm_execpath
if (!pnpm || !existsSync(pnpm)) throw new Error('请通过 pnpm run build 装配桌面制品')
const fast = process.argv.includes('--fast')
const options = process.argv.slice(2).filter((option) => option !== '--' && option !== '--sea' && option !== '--fast')
if (fast && !options.includes('--dir')) options.push('--dir')
const targetArch = options.includes('--arm64') ? 'arm64' : options.includes('--x64') ? 'x64' : process.arch
if (fast && targetArch !== process.arch) throw new Error('本地快速打包只支持与当前机器相同的 CPU 架构')
const sea = options.includes('--win') || (!options.includes('--mac') && process.platform === 'win32')
if (sea && (process.platform !== 'win32' || options.includes('--mac')))
  throw new Error('Windows SEA 制品需要在 Windows 上构建')
if (options.some((item) => !['--dir', '--mac', '--win', '--x64', '--arm64'].includes(item)))
  throw new Error('不支持的桌面构建参数')
const feed = process.env.GUGU_DESKTOP_UPDATE_URL
if (fast && feed) throw new Error('本地快速打包不能使用发行更新地址')
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
const runPnpm = (args: string[]) => execFileSync(node, [pnpm, ...args], { cwd: desktop, stdio: 'inherit' })
const staging = resolve(desktop, '.tools')
mkdirSync(staging, { recursive: true })
const cacheRoot = join(staging, 'package-cache')
const cacheState = join(cacheRoot, 'steps')
function ensureCacheDirectory(path: string) {
  const marker = join(path, '.gugu-package-cache-v1')
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
      throw new Error('快速打包缓存目录不是普通目录')
    if (existsSync(marker)) {
      if (readFileSync(marker, 'utf8') !== 'gugu-desktop-package-cache-v1\n')
        throw new Error('快速打包缓存所有权标记无效')
    } else {
      if (readdirSync(path).length) throw new Error('快速打包缓存目录缺少所有权标记，请先检查该目录')
      writeFileSync(marker, 'gugu-desktop-package-cache-v1\n')
    }
  } else {
    mkdirSync(path, { recursive: true })
    writeFileSync(marker, 'gugu-desktop-package-cache-v1\n')
  }
}
if (fast) {
  ensureCacheDirectory(cacheRoot)
  ensureCacheDirectory(cacheState)
}
const environmentKey = `${process.platform}-${process.arch}-node${process.versions.node}`
async function runCachedStep(name: string, key: string, outputs: string[], action: () => Promise<void> | void, cacheAllowed = true) {
  const statePath = join(cacheState, `${name}-${environmentKey}.json`)
  if (fast && cacheAllowed && outputs.every(existsSync)) {
    try {
      if (JSON.parse(readFileSync(statePath, 'utf8')).key === key) {
        console.log(`快速打包：复用 ${name}`)
        return
      }
    } catch { /* 没有可复用的缓存记录，按正常流程构建。 */ }
  }
  await action()
  if (fast && cacheAllowed) writeFileSync(statePath, JSON.stringify({ key }) + '\n')
}

const workspaceInputs = workspaceFingerprintPaths(root)
const toolchain = `${process.platform}:${process.arch}:${process.versions.node}:${process.versions.modules}`
const pnpmVersion = fast ? execFileSync(node, [pnpm, '--version'], { encoding: 'utf8' }).trim() : ''
const sidecarTarget = join(desktop, 'resources', sea ? 'core-sidecar-sea' : 'core-sidecar')
const sidecarKey = fast ? fingerprintPaths([
  ...workspaceInputs,
  join(root, 'packages'),
  join(desktop, 'package.json'),
  join(desktop, 'scripts/build'),
  join(desktop, 'electron-builder.yml'),
], `${toolchain}:sea=${sea}`) : ''
await runCachedStep('core-sidecar', sidecarKey, [join(sidecarTarget, 'manifest.json')], async () => {
  run(join(desktop, 'scripts/build/prepare-sidecar.mjs'), sea ? ['--sea'] : [])
  if (fast) run(join(desktop, 'scripts/verify/smoke-sidecar.mjs'), sea ? ['--root', sidecarTarget] : [])
})

const desktopBuildKey = fast ? fingerprintPaths([
  join(desktop, 'src'),
  join(desktop, 'native'),
  join(desktop, 'scripts/build'),
  join(root, 'packages'),
  join(desktop, 'package.json'),
  join(root, 'packages/core/src/agent/subagent/searcher/prompt.md'),
  join(root, 'pnpm-lock.yaml'),
], toolchain) : ''
await runCachedStep('desktop-main', desktopBuildKey, [
  join(desktop, 'dist/main/index.cjs'),
  join(desktop, 'dist/preload/index.cjs'),
  join(desktop, 'dist/preload/chat-fab.cjs'),
  join(desktop, 'dist/gateway/qq.cjs'),
  join(desktop, 'dist/gateway/platforms.cjs'),
  join(desktop, 'dist/gateway/prompt.md'),
  join(desktop, '.tools/agent/runtime.mjs'),
], () => { run(join(desktop, 'scripts/build/build.mjs')) }, !process.env.GUGU_GMAIL_OAUTH_CLIENT_ID?.trim())

if (fast) {
  const emailKey = fingerprintPaths([
    join(root, 'packages/email/src'),
    join(root, 'packages/email/tsconfig.json'),
    join(root, 'packages/email/package.json'),
    join(root, 'pnpm-lock.yaml'),
  ], toolchain)
  await runCachedStep('email-package', emailKey, [join(root, 'packages/email/dist/service.js')], () =>
    { runPnpm(['--filter', '@gugu/email', 'build']) })
  run(join(root, 'packages/charts/scripts/build.mjs'))
}

const uiBuildKey = fast ? fingerprintPaths([
  join(root, 'apps/ui'),
  ...workspaceInputs,
], toolchain) : ''
const uiDependenciesKey = fast ? fingerprintPaths([join(root, 'packages')], toolchain, true) : ''
const completeUiKey = `${uiBuildKey}:${uiDependenciesKey}`
const uiEnvFiles = fast && readdirSync(join(root, 'apps/ui')).some((name) => /^\.env(?:\.|$)/.test(name))
const uiCacheAllowed = !uiEnvFiles && !Object.keys(process.env).some((name) => name.startsWith('VITE_'))
await runCachedStep('desktop-ui', completeUiKey, [join(root, 'apps/ui/dist-desktop/index.html')], () => {
  if (fast) {
    runPnpm(['--filter', 'gugu-web', 'exec', 'vite', 'build', '--config', 'vite.desktop.config.js'])
    return
  }
  runPnpm(['--filter', 'gugu-web', 'build:desktop'])
}, uiCacheAllowed)

if (!fast) run(join(desktop, 'scripts/verify/smoke-sidecar.mjs'), sea ? ['--root', sidecarTarget] : [])

// 图标在依赖部署缓存建键前生成，缓存内容与实际打包资源保持一致。
if (fast) {
  const buildWindowsIcons = options.includes('--win') || (!options.includes('--mac') && process.platform === 'win32')
  const buildMacIcons = options.includes('--mac') || (!options.includes('--win') && process.platform === 'darwin')
  const iconInputs = [
    join(desktop, 'scripts/build/build-icons.mjs'),
    join(desktop, 'scripts/build/build-windows-icons.mjs'),
    join(desktop, 'assets/icon-macos.svg'),
    join(root, 'apps/ui/public/brand'),
    join(root, 'packages/charts'),
    join(root, 'pnpm-lock.yaml'),
  ]
  const iconKey = fingerprintPaths(iconInputs, `${toolchain}:mac=${buildMacIcons}:win=${buildWindowsIcons}`)
  const iconOutputs = [
    ...(buildMacIcons ? [join(desktop, 'assets/icon.icns')] : []),
    ...(buildWindowsIcons ? [join(desktop, 'assets/icon-win-light.ico'), join(desktop, 'assets/icon-win-dark.ico')] : []),
  ]
  await runCachedStep('desktop-icons', iconKey, iconOutputs, () => {
    run(join(desktop, 'scripts/build/build-icons.mjs'))
    if (buildWindowsIcons) run(join(desktop, 'scripts/build/build-windows-icons.mjs'))
  })
} else {
  run(join(desktop, 'scripts/build/build-icons.mjs'))
  if (options.includes('--win') || (!options.includes('--mac') && process.platform === 'win32'))
    run(join(desktop, 'scripts/build/build-windows-icons.mjs'))
}

let stage = mkdtempSync(join(staging, 'electron-app-'))
let persistentStage = false
const deployCacheAllowed = fast && uiCacheAllowed && !process.env.GUGU_GMAIL_OAUTH_CLIENT_ID?.trim()
if (deployCacheAllowed) {
  const deployKey = fingerprintPaths([
    join(root, 'package.json'),
    join(root, 'pnpm-lock.yaml'),
    join(root, 'pnpm-workspace.yaml'),
    join(root, 'packages/email/package.json'),
    join(root, 'packages/email/README.md'),
    join(root, 'packages/email/dist'),
    join(desktop, 'assets'),
    join(desktop, 'package.json'),
    join(desktop, 'README.md'),
  ], `${toolchain}:deploy:target=${targetArch}:pnpm=${pnpmVersion}`, true)
  const deployCache = join(cacheRoot, 'deploy', `${environmentKey}-${targetArch}`)
  ensureCacheDirectory(deployCache)
  const cachedStage = join(deployCache, 'app')
  const keyMarker = join(deployCache, 'fingerprint.json')
  let recordedKey: string | undefined
  try { recordedKey = JSON.parse(readFileSync(keyMarker, 'utf8')).key }
  catch { /* 首次构建或缓存记录缺失，重新部署依赖。 */ }
  let reusableStage = recordedKey === deployKey
  try {
    reusableStage = reusableStage && lstatSync(cachedStage).isDirectory() && !lstatSync(cachedStage).isSymbolicLink()
      && lstatSync(join(cachedStage, 'package.json')).isFile()
      && lstatSync(join(cachedStage, 'node_modules')).isDirectory()
      && !lstatSync(join(cachedStage, 'node_modules')).isSymbolicLink()
  } catch { /* 缺少或损坏的部署缓存时重新生成。 */ }
  if (reusableStage) {
    rmSync(stage, { recursive: true, force: true })
    stage = cachedStage
    persistentStage = true
    console.log('快速打包：复用生产依赖部署目录')
  } else {
    try {
      run(pnpm, ['--filter', 'gugu-desktop', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', stage])
      if (existsSync(cachedStage)) {
        if (!lstatSync(cachedStage).isDirectory() || lstatSync(cachedStage).isSymbolicLink())
          throw new Error('快速打包旧依赖缓存不是普通目录')
        rmSync(cachedStage, { recursive: true, force: true })
      }
      renameSync(stage, cachedStage)
      stage = cachedStage
      persistentStage = true
      writeFileSync(keyMarker, JSON.stringify({ key: deployKey }) + '\n')
    } catch (error) {
      if (stage.startsWith(staging + sep) && !lstatSync(stage).isSymbolicLink())
        rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      throw error
    }
  }
}
try {
  if (!persistentStage) run(pnpm, [
    '--filter', 'gugu-desktop', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', stage,
  ])
  // 快速缓存保留生产依赖，但每次用本轮构建产物覆盖 Electron 代码与 UI。
  if (fast) {
    rmSync(join(stage, 'dist'), { recursive: true, force: true })
    cpSync(join(desktop, 'dist'), join(stage, 'dist'), { recursive: true })
    rmSync(join(stage, 'ui'), { recursive: true, force: true })
  }
  cpSync(resolve(root, 'apps/ui/dist-desktop'), join(stage, 'ui'), {
    recursive: true,
  })
  if (!sea) {
    const packagedCli = join(stage, 'dist/cli/gugu.cjs')
    if (fast) {
      const cliCacheKey = fingerprintPaths([
        join(root, 'packages'),
        join(root, 'pnpm-lock.yaml'),
      ], `${toolchain}:cli`)
      const cliCacheDirectory = join(cacheRoot, 'cli', environmentKey)
      ensureCacheDirectory(cliCacheDirectory)
      const cachedCli = join(cliCacheDirectory, 'gugu.cjs')
      const cliKeyMarker = join(cliCacheDirectory, 'fingerprint.json')
      let cliReusable = false
      try { cliReusable = JSON.parse(readFileSync(cliKeyMarker, 'utf8')).key === cliCacheKey && lstatSync(cachedCli).isFile() }
      catch { /* 首次构建或缓存缺失时重新打包 CLI。 */ }
      if (!cliReusable) {
        const temporaryCli = join(cliCacheDirectory, `gugu-${process.pid}.cjs`)
        mkdirSync(cliCacheDirectory, { recursive: true })
        buildSync({
          entryPoints: [join(root, 'packages/cli/src/bin.ts')],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          outfile: temporaryCli,
        })
        if (existsSync(cachedCli)) rmSync(cachedCli, { force: true })
        renameSync(temporaryCli, cachedCli)
        writeFileSync(cliKeyMarker, JSON.stringify({ key: cliCacheKey }) + '\n')
      }
      mkdirSync(dirname(packagedCli), { recursive: true })
      cpSync(cachedCli, packagedCli)
    } else {
      mkdirSync(dirname(packagedCli), { recursive: true })
      buildSync({
        entryPoints: [join(root, 'packages/cli/src/bin.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: packagedCli,
      })
    }
  }
  cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
  let config = join(desktop, 'electron-builder.yml')
  let builtWindowsInstaller = false
  if (sea) {
    const builderRequire = createRequire(require.resolve('electron-builder/cli.js'))
    const { load } = createRequire(builderRequire.resolve('app-builder-lib'))('js-yaml')
    const result = await configureWindowsInstaller({
      stage, feed, options, seaConfig: load(readFileSync(config, 'utf8')), packageRequire: builderRequire,
    })
    config = result.config
    builtWindowsInstaller = result.builtWindowsInstaller
  }
  if (!builtWindowsInstaller) run(require.resolve('electron-builder/cli.js'), [
    '--config',
    config,
    `--config.directories.app=${stage}`,
    '--publish',
    'never',
    ...releaseOptions,
    ...options,
  ])
} finally {
  if (!stage.startsWith(staging + sep) || lstatSync(stage).isSymbolicLink())
    throw new Error('构建暂存目录超出预期范围')
  if (!persistentStage) rmSync(stage, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  })
}
