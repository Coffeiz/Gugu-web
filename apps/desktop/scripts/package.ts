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
const node = process.execPath
const run = (script: string, args: string[] = []) =>
  execFileSync(node, [script, ...args], { cwd: desktop, stdio: 'inherit' })
run(join(root, 'packages/core/scripts/build.mjs'))
run(join(desktop, 'scripts/build.mjs'))
run(pnpm, ['--filter', 'gugu-web', 'build:desktop'])
run(join(desktop, 'scripts/prepare-sidecar.mjs'))
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
  cpSync(resolve(root, 'apps/web/dist-desktop'), join(stage, 'ui'), {
    recursive: true,
  })
  cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
  run(require.resolve('electron-builder/cli.js'), [
    '--config',
    join(desktop, 'electron-builder.yml'),
    `--config.directories.app=${stage}`,
    '--publish',
    'never',
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
