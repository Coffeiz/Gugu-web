// 将已固定的当前平台 Node 和生产依赖装配为自包含制品；不在用户启动时下载。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
import { fileURLToPath } from 'node:url'

const desktop = resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = resolve(desktop, '../..')
const core = join(root, 'packages/core')
const pnpm = process.env.npm_execpath
if (!pnpm || !existsSync(pnpm)) throw new Error('请通过 pnpm run prepare:sidecar 装配制品')
if (!/^v26\./.test(process.version) || Number(process.versions.node.split('.')[1]) < 13)
  throw new Error('桌面制品需要固定的 Node 26.13 或更新的 26 LTS')
execFileSync(process.execPath, [join(core, 'scripts/build.mjs')], {
  cwd: root,
  stdio: 'inherit',
})
const resourceParent = join(desktop, 'resources'),
  target = join(resourceParent, 'core-sidecar')
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
try {
  const host = join(stage, 'host')
  execFileSync(
    process.execPath,
    [
      pnpm,
      '--filter',
      '@gugu/core',
      'deploy',
      '--prod',
      '--legacy',
      '--config.node-linker=hoisted',
      host,
    ],
    { cwd: root, stdio: 'inherit' },
  )
  // deploy 的模块结构必须自包含，禁止把工作区链接带进安装包。
  const expanded = join(stage, 'runtime')
  cpSync(host, expanded, { recursive: true, dereference: true })
  rmSync(owned(host), { recursive: true, force: true })
  renameSync(expanded, host)
  cpSync(join(root, 'LICENSE'), join(host, 'LICENSE'))
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  cpSync(process.execPath, join(stage, executable))
  const license = [
    join(dirname(process.execPath), 'LICENSE'),
    resolve(dirname(process.execPath), '../LICENSE'),
    resolve(dirname(process.execPath), '../share/doc/node/LICENSE'),
  ].find((path) => existsSync(path) && readFileSync(path, 'utf8').includes('Node.js'))
  if (!license) throw new Error('Node 发行制品缺少可核验的许可证文件')
  cpSync(license, join(stage, 'NODE-LICENSE'))
  const files = {}
  const dependencies = new Map()
  function inventory(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory()) inventory(path)
      else if (item.isFile()) {
        files[relative(stage, path).split(sep).join('/')] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex')
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
    schema: 3,
    executable,
    entry: 'host/dist/runtime/transport/stdio.js',
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
} finally {
  if (existsSync(stage)) rmSync(owned(stage), { recursive: true, force: true })
}
