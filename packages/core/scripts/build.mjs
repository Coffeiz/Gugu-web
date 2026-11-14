import { lstatSync, existsSync, rmSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { coreRoot } from './test-suites.mjs'

const require = createRequire(import.meta.url)
const sandboxBuild = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', resolve(coreRoot, '../sandbox/tsconfig.json')], { stdio: 'inherit' })
if (sandboxBuild.status !== 0) process.exit(sandboxBuild.status ?? 1)

const output = resolve(coreRoot, 'dist')
if (
  relative(coreRoot, output) !== 'dist' ||
  (existsSync(output) && lstatSync(output).isSymbolicLink())
)
  throw new Error('Core 构建产物路径超出预期范围')
rmSync(output, { recursive: true, force: true })
const result = spawnSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', join(coreRoot, 'tsconfig.json')],
  { stdio: 'inherit' },
)
process.exitCode = result.status ?? 1
