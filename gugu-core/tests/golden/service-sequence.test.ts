import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { dataContext } from '../../src/contracts/index.js'
import type { DataServices } from '../../src/application/services.js'

const root = resolve(import.meta.dirname, '../../..'),
  python = process.env.GUGU_CORE_GOLDEN_PYTHON
if (!python) throw new Error('对照必须显式提供 GUGU_CORE_GOLDEN_PYTHON')
// 两个独立库的 owner/时钟由各自运行时生成；精度和隔离另由固定时钟双库契约保护。
function normalized(value: any): any {
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'user_id'
          ? '<owner>'
          : key.endsWith('_at') && item !== null
            ? '<timestamp>'
            : normalized(item),
      ]),
    )
  return value
}
it('Python/Node 对相同维护序列保留结果、回滚、CAS、归档及错误类别', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gugu-service-parity-')),
    database = join(folder, 'node.db')
  const sequence = JSON.parse(
    readFileSync(join(root, 'gugu-core/tests/fixtures/service-sequence.json'), 'utf8'),
  )
  const reference = spawnSync(
    python,
    [join(root, 'backend/tests/core/fixtures/node_golden.py')],
    {
      input: JSON.stringify({
        action: 'services',
        database: join(folder, 'python.db'),
        sequence,
      }),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PYTHONUTF8: '1' },
    },
  )
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
  try {
    expect(reference.status).toBe(0)
    await initializeSqlite(database)
    runtime = await openSqliteRuntime(database)
    const context = dataContext(runtime.ownerId),
      actual = []
    async function command(data: DataServices, item: any): Promise<unknown> {
      switch (item.method) {
        case 'clients.create':
          return data.clients.create(item.fields)
        case 'clients.update':
          return data.clients.update(item.id, item.fields)
        case 'clients.delete':
          await data.clients.delete(item.id)
          return null
        case 'clients.list':
          return data.clients.list()
        case 'projects.create':
          return data.projects.create(item.fields)
        case 'projects.update':
          return data.projects.update(item.id, item.version, item.fields)
        case 'projects.list':
          return data.projects.list(item.archived ?? false)
        default:
          throw new Error('不支持的合成测试命令')
      }
    }
    for (const item of sequence) {
      try {
        const result = await runtime.runtime.transaction(context, async (data) => {
          if (item.batch) {
            const results = []
            for (const part of item.batch) results.push(await command(data, part))
            return results
          }
          return command(data, item)
        })
        actual.push({ result })
      } catch (error: any) {
        actual.push({ error: error.code ?? 'unexpected' })
      }
    }
    expect(normalized(actual)).toEqual(normalized(JSON.parse(reference.stdout)))
    expect(actual[4]).toMatchObject({
      result: [{ name: '合成联系人', notes: '已更新', phone: null }],
    })
    expect(actual.at(-1)).toEqual({ result: [] })
  } finally {
    await runtime?.runtime.close()
    rmSync(folder, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }
})
