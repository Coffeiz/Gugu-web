import { describe, expect, it } from 'vitest'
import { canvasViewSummary } from '../../src/mind/canvas-read.js'

describe('画布 Agent 视图兼容', () => {
  it('保留 Python bool 数值语义并排除无效坐标', () => {
    expect(canvasViewSummary(JSON.stringify({ x: false, y: 2, scale: '3', viewport: { width: true, height: null }, last_viewed_at: 3 }))).toEqual({ camera: { x: false, y: 2 }, viewport: { width: true }, last_viewed_at: null })
    expect(canvasViewSummary('{')).toEqual({ camera: null, viewport: null, last_viewed_at: null })
  })
})

it('真实 SQLite 注册器分页不截断总数且隔离 owner、软删和项计数', async () => {
  const { default: SQLite } = await import('better-sqlite3')
  const { Kysely, SqliteDialect } = await import('kysely')
  const { tablesSql } = await import('../../src/data/schema.js')
  const { createSqlMindCanvasReader } = await import('../../src/mind/canvas-read.js')
  const { createCanvasReadTools } = await import('../../src/agent/tools/canvas/index.js')
  const { createToolRegistry } = await import('../../src/agent/tools/registry.js')
  const connection = new SQLite(':memory:')
  const schema = tablesSql('sqlite')
  connection.pragma('foreign_keys = OFF')
  connection.exec(schema.mindMaps + ';' + schema.mindItems)
  const db = new Kysely<import('../../src/data/schema.js').Database>({ dialect: new SqliteDialect({ database: connection }) })
  const ownerId = '00000000-0000-4000-8000-000000000001', owner = ownerId.replaceAll('-', '')
  const other = '00000000000040008000000000000002', stamp = '2026-11-14 10:00:00'
  const insert = connection.prepare('INSERT INTO mind_maps VALUES (?,?,?,1,?,?,?,?)')
  for (let id = 1; id <= 205; id++) insert.run(id, owner, '合成画布', '{}', stamp, stamp, null)
  insert.run(206, other, '他人画布', '{}', stamp, stamp, null)
  insert.run(207, owner, '已删画布', '{}', stamp, stamp, stamp)
  const item = connection.prepare("INSERT INTO mind_canvas_items VALUES (?,?,205,?,0,0,NULL,NULL,0,0,'{}',?,?,?)")
  item.run(1, owner, 1001, stamp, stamp, null)
  item.run(2, owner, 1002, stamp, stamp, stamp)
  item.run(3, other, 1003, stamp, stamp, null)
  const registry = createToolRegistry({ tools: createCanvasReadTools(createSqlMindCanvasReader(db, 'sqlite')), authorize: async () => true })
  const scope = { identity: { ownerId, sessionId: 'session', runId: 'run' }, roundId: 'round', resolution: null, signal: new AbortController().signal, execute: async () => { throw new Error('不执行进程') } }
  try {
    const result = await registry.tools.dispatch({ id: 'list', name: 'canvas_list', input: { limit: 1 } }, scope)
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false, value: { total: 205, limit: 1, offset: 0, canvases: [{ canvas_id: 205, node_count: 1 }] } })
    const tail = await registry.tools.dispatch({ id: 'tail', name: 'canvas_list', input: { limit: 20, offset: 200 } }, scope)
    expect(tail).toMatchObject({ value: { total: 205, canvases: [5,4,3,2,1].map(canvas_id => ({ canvas_id, node_count: 0 })) } })
    const { fixture, collect } = await import('../agent/run/fixtures.js')
    const { createAgentRunner } = await import('../../src/agent/index.js')
    const f = fixture([
      [{ type: 'complete', text: '', calls: [{ id: 'canvas-call', name: 'canvas_list', input: { limit: 1 } }] }],
      [{ type: 'complete', text: '已读取画布', calls: [] }],
    ])
    f.ports.tools = registry.tools
    const run = await collect(createAgentRunner(f.ports).start(scope.identity))
    expect(run.state.status).toBe('completed')
    expect(f.ports.context.afterTool).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'canvas_list' }), expect.objectContaining({ successful: true, value: expect.objectContaining({ total: 205 }) }), expect.anything())
    const filtered = await registry.tools.dispatch({ id: 'filter', name: 'canvas_list', input: { project_id: 2 } }, scope)
    expect(filtered).toMatchObject({ value: { total: 0, canvases: [] } })
    const before = new AbortController(); before.abort()
    await expect(registry.tools.dispatch({ id:'cancel',name:'canvas_list',input:{} },{...scope,signal:before.signal})).rejects.toThrow()
    const after = new AbortController()
    const wrapped = db.withPlugin({transformQuery:args=>args.node,async transformResult(args){after.abort();return args.result}})
    const cancelled = createToolRegistry({tools:createCanvasReadTools(createSqlMindCanvasReader(wrapped,'sqlite')),authorize:async()=>true})
    await expect(cancelled.tools.dispatch({id:'post',name:'canvas_list',input:{}},{...scope,signal:after.signal})).rejects.toThrow()
    connection.exec('DROP TABLE mind_canvas_items')
    expect(await registry.tools.dispatch({id:'missing',name:'canvas_list',input:{}},scope)).toMatchObject({successful:false,value:{error:'工具执行失败'}})

  } finally { await db.destroy() }
})
