import { lstatSync, existsSync, rmSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { coreRoot } from './test-suites.mjs'

const require = createRequire(import.meta.url)
for (const name of ['sandbox', 'database']) {
  const dependency = spawnSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', resolve(coreRoot, `../${name}/tsconfig.json`)],
    { stdio: 'inherit' },
  )
  if (dependency.status !== 0) process.exit(dependency.status ?? 1)
}

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
if (result.status !== 0) {
  process.exitCode = result.status ?? 1
} else {
  const skills = spawnSync(process.execPath, [join(coreRoot, 'scripts/build-skills.mjs')], { stdio: 'inherit' })
  process.exitCode = skills.status ?? 1
}
