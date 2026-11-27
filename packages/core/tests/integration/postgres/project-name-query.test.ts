import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, test } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { createPostgresRuntime } from '../../../src/data/postgres.js'
import { tablesSql } from '../../../src/data/schema.js'
import { createGetProjectTool } from '../../../src/agent/tools/projects/index.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('项目名称查询必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')

test('真实隔离PostgreSQL项目查询保护owner/删除边界并保持原生ILIKE', async () => {
  const schema = `gugu_project_query_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), other = randomUUID()
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  let runtime: Awaited<ReturnType<typeof createPostgresRuntime>> | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(tablesSql('postgres').projects)
    runtime = await createPostgresRuntime({ url: url!, schema })
    const add = (name: string, user = owner, archived = false) => runtime!.transaction(dataContext(user), data => data.projects.repository.create({ name, archived }))
    const names = async (name: string, user = owner) => (await runtime!.transaction(dataContext(user), data => data.projects.findByName(name))).map(row => row.name).sort()
    const active = await add('小北'), archived = await add('小北', owner, true)
    await add('小北同学'); await add('小北同学', other)
    const exact = await runtime.transaction(dataContext(owner), data => data.projects.findByName('小北'))
    expect(new Set(exact.map(row => row.id))).toEqual(new Set([active.id, archived.id]))
    expect(exact.some(row => row.archived)).toBe(true)
    expect(await names('小北', other)).toEqual(['小北同学'])
    const deleted = await add('已删项目')
    await add('已删项目扩展'); await add('已删项目', other)
    await admin.query('UPDATE projects SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2', [deleted.id, owner])
    expect(await names('已删项目')).toEqual(['已删项目扩展'])
    expect(await names('已删项目', other)).toEqual(['已删项目'])
    await add('alpha'); await add('alXha')
    expect(await names('al_ha')).toEqual(['alXha', 'alpha'])
    expect(await names('a%a')).toEqual(['alXha', 'alpha'])
    await add('a_b'); await add('a\\xb')
    expect(await names('a\\_b')).toEqual(['a_b'])
    await add('Änne'); await add('ASCII')
    const native = await admin.query<{ matched: boolean }>('SELECT $1::text ILIKE $2::text AS matched', ['Änne', '%änne%'])
    expect(await names('änne')).toEqual(native.rows[0]!.matched ? ['Änne'] : [])
    expect(await names('ascii')).toEqual(['ASCII'])
    await add('Ä'); await add('ä')
    expect(await names('Ä')).toEqual(['Ä'])
    expect(await names('ä')).toEqual(['ä'])
    await add("O'Reilly")
    expect(await names("O'Rei")).toEqual(["O'Reilly"])
    expect(await names("' OR 1=1 --")).toEqual([])
    expect(await names("%'; DROP TABLE projects; --")).toEqual([])
    await add('  padded  ')
    expect(await names('  padded  ')).toEqual(['  padded  '])
    expect(await names('  alpha  ')).toEqual([])
    const before = await admin.query<{ id: number }>('SELECT id FROM projects WHERE user_id=$1 AND deleted_at IS NULL AND name ILIKE $2', [owner, '%%'])
    const rows = await runtime.transaction(dataContext(owner), data => data.projects.findByName('%'))
    expect(rows.map(row => row.id)).toEqual(before.rows.map(row => row.id))
    // 查询/定位为真实PG；此处文件概览仅为可信零计数端口替身，不验证文件后端。
    let overviews = 0
    const registry = createToolRegistry({ tools: [createGetProjectTool({ core: runtime,
      async fileOverview() { overviews++; return { total_file_count: 0, root_file_count: 0, total_folder_count: 0 } },
    })], authorize: async () => true })
    const dispatch = (input: unknown, ownerId = owner) => registry.tools.dispatch({ id: randomUUID(), name: 'get_project', input }, {
      identity: { ownerId, sessionId: 'query-session', runId: 'query-run' }, roundId: 'query-round', resolution: null,
      signal: new AbortController().signal, execute: async () => { throw new Error('不得执行命令') },
    })
    expect(await dispatch({ project: 'a\\_b' })).toMatchObject({ successful: true, value: { name: 'a_b' } })
    expect(await dispatch({ project: '小北' })).toMatchObject({ successful: true, value: { id: active.id, archived: false } })
    expect(await dispatch({ project: 'a\\_b' }, other)).toMatchObject({ successful: false, mutated: false })
    expect(await dispatch({ project_id: active.id }, other)).toMatchObject({ successful: false, mutated: false })
    expect(overviews).toBe(2)
  } finally {
    await runtime?.close()
    try {
      if (!/^gugu_project_query_[a-f0-9]{32}$/.test(schema)) throw new Error('测试schema范围无效')
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally { await admin.end() }
  }
})
