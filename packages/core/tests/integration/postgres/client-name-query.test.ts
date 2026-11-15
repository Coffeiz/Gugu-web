import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, test } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { createPostgresRuntime } from '../../../src/data/postgres.js'
import { tablesSql } from '../../../src/data/schema.js'
import { createClientTools } from '../../../src/agent/tools/clients.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('联系人名称查询必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')

test('真实隔离PostgreSQL联系人查询保留owner、精确优先与数据库ILIKE语义', async () => {
  const schema = `gugu_client_query_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), other = randomUUID()
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  let runtime: Awaited<ReturnType<typeof createPostgresRuntime>> | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(tablesSql('postgres').clients)
    runtime = await createPostgresRuntime({ url: url!, schema })
    const add = (name: string, user = owner) => runtime!.transaction(dataContext(user), data => data.clients.create({ name }))
    const names = async (name: string, user = owner) => (await runtime!.transaction(dataContext(user), data => data.clients.findByName(name))).map(row => row.name).sort()
    await add('小北'); await add('小北同学'); await add('小北', other)
    expect(await names('小北')).toEqual(['小北'])
    expect(await names('北')).toEqual(['小北', '小北同学'])
    expect(await names('北', other)).toEqual(['小北'])
    expect(await names('同学', other)).toEqual([])
    await add('alpha'); await add('alXha')
    expect(await names('al_ha')).toEqual(['alXha', 'alpha'])
    expect(await names('a%a')).toEqual(['alXha', 'alpha'])
    await add('a_b'); await add('a\\xb')
    // PG默认反斜线转义，与SQLite默认LIKE的反斜线字面语义不同。
    expect(await names('a\\_b')).toEqual(['a_b'])
    await add('Änne'); await add('ASCII')
    // Unicode大小写取决于实际PG collation；以同库原生ILIKE为基准，不能假设JS折叠等价。
    const folded = await admin.query<{ matched: boolean }>('SELECT $1::text ILIKE $2::text AS matched', ['Änne', '%änne%'])
    expect(await names('änne')).toEqual(folded.rows[0]!.matched ? ['Änne'] : [])
    expect(await names('ascii')).toEqual(['ASCII'])
    await add("O'Reilly")
    expect(await names("O'Rei")).toEqual(["O'Reilly"])
    expect(await names("' OR 1=1 --")).toEqual([])
    expect(await names("%'; DROP TABLE clients; --")).toEqual([])
    const registry = createToolRegistry({ tools: createClientTools(runtime), authorize: async () => true })
    const dispatch = (input: unknown, ownerId = owner) => registry.tools.dispatch({ id: randomUUID(), name: 'update_client', input }, {
      identity: { ownerId, sessionId: '1', runId: 'query-run' }, roundId: 'query-round', resolution: null,
      signal: new AbortController().signal, execute: async () => { throw new Error('不得执行命令') },
    })
    expect(await dispatch({ client: 'a\\_b', notes: '原生查询命中' })).toMatchObject({ successful: true })
    const changed = await runtime.transaction(dataContext(owner), data => data.clients.list())
    expect(changed.find(row => row.name === 'a_b')?.notes).toBe('原生查询命中')
    expect(changed.find(row => row.name === 'a\\xb')?.notes).toBe('')
    expect(await dispatch({ client: 'a\\_b', notes: '越权写入' }, other)).toMatchObject({ successful: false, mutated: false })
    expect(await dispatch({ client_id: changed.find(row => row.name === 'a_b')!.id, notes: '越权写入' }, other)).toMatchObject({ successful: false, mutated: false })
    const list = await runtime.transaction(dataContext(owner), data => data.clients.list())
    expect(list.map(row => row.id)).toEqual([...list.map(row => row.id)].sort((a, b) => b - a))
  } finally {
    await runtime?.close()
    try {
      if (!/^gugu_client_query_[a-f0-9]{32}$/.test(schema)) throw new Error('测试schema范围无效')
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally { await admin.end() }
  }
})
