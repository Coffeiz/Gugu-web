// 将已固定的当前平台 Node 和生产依赖装配为自包含制品；不在用户启动时下载。
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { buildCore } from '../../../packages/core/scripts/build.mjs'
import { buildDesktopAgentRuntime } from './build-agent-runtime.mjs'
import { prepareDesktopPty } from './prepare-pty.mjs'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = resolve(desktop, '../..')
const core = join(root, 'packages/core')
const pnpm = process.env.npm_execpath
if (!pnpm || !existsSync(pnpm)) throw new Error('请通过 pnpm run prepare:sidecar 装配制品')
if (!/^v26\./.test(process.version) || Number(process.versions.node.split('.')[1]) < 13)
  throw new Error('桌面制品需要固定的 Node 26.13 或更新的 26 LTS')
const resourceParent = join(desktop, 'resources'),
  target = join(resourceParent, 'core-sidecar')
const executable = process.platform === 'win32' ? 'node.exe' : 'node'
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const isolatedEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|LD_.*|DYLD_.*)$/i.test(key)))

function runPnpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpm, ...args], { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm ${args[2]} 失败（${code ?? signal}）`))
    })
  })
}

function canRunStandalone(path) {
  try {
    const version = execFileSync(path, ['--version'], { env: isolatedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return version.trim() === process.version
  } catch {
    return false
  }
}

function installedRuntime() {
  const node = join(target, executable)
  const license = join(target, 'NODE-LICENSE')
  const manifestPath = join(target, 'manifest.json')
  if (![node, license, manifestPath].every(existsSync) || realpathSync(target) !== target) return null
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch ||
      manifest.nodeVersion !== process.versions.node || manifest.nodeAbi !== process.versions.modules) return null
  if (realpathSync(node) !== node || realpathSync(license) !== license ||
      manifest.files?.[executable] !== digest(node) || manifest.files?.['NODE-LICENSE'] !== digest(license) ||
      !canRunStandalone(node)) return null
  return { node, license }
}

mkdirSync(resourceParent, { recursive: true })
mkdirSync(join(desktop, '.tools'), { recursive: true })
const stage = mkdtempSync(join(desktop, '.tools/sidecar-stage-'))
function owned(path) {
  const absolute = resolve(path)
  if (
    !absolute.startsWith(root + sep) ||
    (!absolute.startsWith(join(desktop, '.tools') + sep) && absolute !== target)
  )
    throw new Error('制品清理路径超出预期范围')
  return absolute
}
async function prepareSidecar() {
  await buildDesktopAgentRuntime()
  const { CORE_SCHEMA_VERSION } = await import(pathToFileURL(join(core, 'dist/contracts/desktop.js')).href)
  const host = join(stage, 'host')
  await runPnpm(['--filter', '@gugu/gateway', 'build'])
  await runPnpm(['--filter', '@gugu/core', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', host])
  // deploy 的模块结构必须自包含，禁止把工作区链接带进安装包。
  const expanded = join(stage, 'runtime')
  cpSync(host, expanded, { recursive: true, dereference: true })
  rmSync(owned(host), { recursive: true, force: true })
  renameSync(expanded, host)
  // 独立 Node 运行 SILK 解码，保留共享模块的 ESM 文件布局和锁定解码依赖。
  const gateway = join(root, 'packages/gateway')
  const media = join(host, 'node_modules/@gugu/gateway')
  mkdirSync(join(media, 'dist/runtime'), { recursive: true })
  cpSync(join(gateway, 'package.json'), join(media, 'package.json'))
  cpSync(join(gateway, 'dist/runtime/media'), join(media, 'dist/runtime/media'), { recursive: true })
  const decoder = 'node_modules/@zpowertech/audio-player'
  mkdirSync(dirname(join(host, decoder)), { recursive: true })
  cpSync(join(gateway, decoder), join(host, decoder), { recursive: true, dereference: true })
  prepareDesktopPty(join(host, 'package.json'))
  cpSync(join(root, 'LICENSE'), join(host, 'LICENSE'))
  mkdirSync(join(host, 'agent'), { recursive: true })
  cpSync(join(desktop, '.tools/agent/runtime.mjs'), join(host, 'agent/runtime.mjs'))
  cpSync(join(desktop, '.tools/agent/prompt.md'), join(host, 'agent/prompt.md'))
  cpSync(join(core, 'resources/prompts'), join(host, 'agent-prompts'), { recursive: true })
  const installed = installedRuntime()
  const embeddedNode = join(stage, executable)
  cpSync(installed?.node ?? process.execPath, embeddedNode)
  const license = installed?.license ?? [
    join(dirname(process.execPath), 'LICENSE'),
    resolve(dirname(process.execPath), '../LICENSE'),
    resolve(dirname(process.execPath), '../share/doc/node/LICENSE'),
  ].find((path) => existsSync(path) && readFileSync(path, 'utf8').includes('Node.js'))
  if (!license) throw new Error('Node 发行制品缺少可核验的许可证文件')
  cpSync(license, join(stage, 'NODE-LICENSE'))
  // 确认复制后的 Node 不依赖安装目录的动态库，再替换已有制品。
  if (!canRunStandalone(embeddedNode))
    throw new Error('复制后的 Node 不能独立运行，请使用官方 Node 发行版准备桌面制品')
  const files = {}
  const dependencies = new Map()
  function inventory(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory()) inventory(path)
      else if (item.isFile()) {
        files[relative(stage, path).split(sep).join('/')] = digest(path)
        if (item.name === 'package.json' && path.includes(`${sep}node_modules${sep}`)) {
          const pkg = JSON.parse(readFileSync(path, 'utf8'))
          if (pkg.name && pkg.version)
            dependencies.set(`${pkg.name}@${pkg.version}`, {
              name: pkg.name,
              version: pkg.version,
              license: pkg.license ?? '未声明',
            })
        }
      } else throw new Error('制品中存在未展开的链接或特殊文件')
    }
  }
  inventory(stage)
  const manifest = {
    coreVersion: JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version,
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    protocol: 2,
    schema: CORE_SCHEMA_VERSION,
    executable,
    entry: 'host/dist/runtime/transport/stdio.js',
    workerEntry: 'host/dist/runtime/worker.js',
    agentRuntimeModule: 'host/agent/runtime.mjs',
    dependencies: [...dependencies.values()],
    files,
  }
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  // 只允许覆盖本脚本先前创建且有标记的制品目录。
  if (existsSync(target)) {
    if (
      realpathSync(target) !== resolve(target) ||
      !existsSync(join(target, 'manifest.json'))
    )
      throw new Error('目标不是可替换的生成制品')
    rmSync(owned(target), { recursive: true, force: true })
  }
  renameSync(stage, target)
  console.log(
    JSON.stringify({
      status: 'prepared',
      platform: process.platform,
      arch: process.arch,
      protocol: 2,
      files: Object.keys(files).length,
    }),
  )
}

try {
  await buildCore(prepareSidecar)
} finally {
  if (existsSync(stage)) rmSync(owned(stage), { recursive: true, force: true })
}
