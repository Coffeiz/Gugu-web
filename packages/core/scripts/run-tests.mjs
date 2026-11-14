import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { coreRoot, testSuites } from './test-suites.mjs'

const suite = process.argv[2] ?? 'default'
const selected = testSuites(suite)
console.log(JSON.stringify({ suite, files: selected }, null, 2))
if (!process.argv.includes('--list')) {
  if (
    selected.some((item) => item.purpose === 'postgres') &&
    !process.env.GUGU_CORE_TEST_POSTGRES_URL
  )
    throw new Error('选择 PG 测试必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
  if (
    selected.some((item) => item.purpose === 'parity') &&
    !process.env.GUGU_CORE_GOLDEN_PYTHON
  )
    throw new Error('选择 Python 对照必须显式提供 GUGU_CORE_GOLDEN_PYTHON')
  for (const args of [
    [join(coreRoot, 'scripts/build.mjs')],
    [join(coreRoot, 'node_modules/vitest/vitest.mjs'), 'run'],
  ]) {
    const result = spawnSync(process.execPath, args, {
      cwd: coreRoot,
      stdio: 'inherit',
      env: { ...process.env, GUGU_CORE_TEST_SUITE: suite },
    })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
