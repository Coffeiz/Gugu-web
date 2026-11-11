import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeProjectStages, prepareProjectCreate, prepareClientFields, replaceProjectStages } from '../../src/domain/index.js'
import { LocalRuntime } from '../../dist/runtime/local.js'
import { migrateSqlite } from '../../src/data/sqlite.js'

const root = fileURLToPath(new URL('../../../', import.meta.url)), folders: string[] = []
const python = process.env.GUGU_CORE_GOLDEN_PYTHON
if (!python) throw new Error('差分测试必须显式提供已安装 Python 兼容包的 GUGU_CORE_GOLDEN_PYTHON')
function golden(request: object): any {
  const result = spawnSync(python!, [join(root, 'backend/tests/core/fixtures/node_golden.py')], { input: JSON.stringify(request), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 20_000 })
  if (result.status !== 0) throw new Error('Python Golden 参考进程执行失败')
  return JSON.parse(result.stdout)
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it('同一合成语料在 Python 和 TS 上保留字段、阶段身份与错误类别', () => {
  const cases = JSON.parse(readFileSync(join(root, 'backend/tests/core/fixtures/core-contracts.json'), 'utf8'))
  const expected = golden({ action: 'domain', cases })
  const actual = cases.map((item: any) => {
    try {
      const result = item.method === 'normalize' ? normalizeProjectStages(item.input) : item.method === 'create' ? prepareProjectCreate(item.input)
        : item.method === 'client' ? prepareClientFields(item.input, true) : replaceProjectStages(item.old, item.current, item.input)
      return { result }
    } catch { return { error: 'invalid_request' } }
  })
  expect(actual).toEqual(expected)
})
it('Python v2 库经 Node 更新后仍能由旧包重读；升级 v3 保留可恢复 v2 备份', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gugu-core-golden-')); folders.push(folder)
  const database = join(folder, '跨语言.db'), original = golden({ action: 'initialize', database })
  const runtime = await LocalRuntime.open(database, { allowLegacySchema: true })
  expect(runtime.ownerId).toBe(original.owner)
  try { await runtime.call('projects.rename', { id: 1, version: 1, name: 'Node 更新计划' }); await runtime.call('clients.create', { name: '小南' }) } finally { await runtime.close() }
  const restored = golden({ action: 'read', database })
  expect(restored.owner).toBe(original.owner); expect(restored.projects[0]).toMatchObject({ name: 'Node 更新计划', version: 2 })
  expect(restored.clients.map((row: any) => row.name)).toEqual(['小南', '小北'])
  const backup = await migrateSqlite(database)
  expect(golden({ action: 'read', database: backup })).toEqual(restored)
  const upgraded = await LocalRuntime.open(database)
  try { expect(await upgraded.call('projects.list')).toEqual(restored.projects) } finally { await upgraded.close() }
})
