import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createSqlAgentInteractionHistory } from '../../../src/agent/sessions/interaction-history.js'

it('正式 SQLite 交互历史校验并归一时间，在事务提交后返回可用 token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-history-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', ''), date = '2026-01-01 00:00:00.000000'
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (1,${owner},'对话',0,'','web',1,${date},${date})`.execute(runtime.db)
      const active = JSON.stringify({ options: [{ id: 5, label: '' }], secret_fields: {}, context: { tool_call_id: 77, secret_target: { kind: 'mcp_credentials' } } })
      const legacy = JSON.stringify(JSON.stringify({ context: { tool_call_id: 'old' } }))
      await sql`INSERT INTO interaction_prompts(id,user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES
        (1,${owner},1,'confirm','活动','',${active},'active','2026-01-01T08:00:02+08:00','2026-01-01T08:00:00.123456+08:00'),
        (2,${owner},1,'confirm','历史','',${legacy},'resolved','2026-01-01 00:00:00','2026-01-01 00:00:00.123456'),
        (3,${owner},1,'confirm','历史后','',${'{}'},'resolved','2026-01-01 00:00:00','2026-01-01 00:00:00.123457')`.execute(runtime.db)
      await sql`INSERT INTO interaction_actions(id,prompt_id,token_hash,action_type,option_id,context_json,status,expires_at,created_at) VALUES
        (1,1,'old','choice','5','{}','pending','2026-01-01T08:00:02+08:00',${date}),
        (3,1,'old','choice','other','{}','pending','2026-01-01 00:00:02',${date})`.execute(runtime.db)
      const list = createSqlAgentInteractionHistory(runtime.db, 'sqlite', () => new Date('2026-01-01T00:00:01Z'))
      const rows = await list(ownerId, 1, { restoreActive: true })
      expect(rows.map(row => row.id)).toEqual([1, 2, 3])
      expect(rows[0]?.tool_call_id).toBe('77'); expect(rows[0]?.options[0]?.label).toBe('')
      expect(rows[1]?.tool_call_id).toBe('old')
      const token = rows[0]!.options[0]!.token
      const saved = await sql<{ token_hash: string }>`SELECT token_hash FROM interaction_actions WHERE id=1`.execute(runtime.db)
      expect(saved.rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
      expect(await list(randomUUID(), 1, { restoreActive: true })).toEqual([])
      const base = Date.parse('2026-01-01T00:00:00.123Z')
      expect((await list(ownerId, 1, { restoreActive: false, startAtMs: `${base}.456`, endBeforeMs: `${base}.457` })).map(row => row.id)).toEqual([2])
      await sql`INSERT INTO interaction_prompts(id,user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES
        (4,${owner},1,'confirm','数字','',${'{"context":{"tool_call_id":77}}'},'resolved',${date},${date}),
        (5,${owner},1,'confirm','字符串','',${'{"context":{"tool_call_id":"77"}}'},'resolved',${date},${date}),
        (6,${owner},1,'confirm','大数字','',${'{"context":{"tool_call_id":9007199254740993}}'},'resolved',${date},${date})`.execute(runtime.db)
      expect((await list(ownerId, 1, { restoreActive: false, toolCallIds: ['77'] })).map(row => row.id)).toEqual([5])
      expect(await list(ownerId, 1, { restoreActive: false, toolCallIds: ['9007199254740993'] })).toEqual([])
      expect((await list(ownerId, 1, { restoreActive: false })).find(row => row.id === 6)?.tool_call_id).toBe('9007199254740993')
      await sql`CREATE TRIGGER fail_history_token BEFORE UPDATE ON interaction_actions WHEN NEW.id=3 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`.execute(runtime.db)
      await expect(list(ownerId, 1, { restoreActive: true })).rejects.toThrow()
      expect((await sql<{ token_hash: string }>`SELECT token_hash FROM interaction_actions WHERE id=1`.execute(runtime.db)).rows[0]!.token_hash).toBe(saved.rows[0]!.token_hash)
      await sql`DROP TRIGGER fail_history_token`.execute(runtime.db)
      const expiry = new Date(Date.now() + 500).toISOString()
      await sql`UPDATE interaction_prompts SET expires_at=${expiry} WHERE id=1`.execute(runtime.db)
      await sql`UPDATE interaction_actions SET expires_at=${expiry} WHERE prompt_id=1`.execute(runtime.db)
      const require = createRequire(import.meta.url)
      const expiryWorker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const db=new (require(workerData.sqlite))(workerData.path);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');setTimeout(()=>{db.exec('COMMIT');db.close()},800)`, { eval: true, workerData: { sqlite: require.resolve('better-sqlite3'), path } })
      try {
        await new Promise<void>((resolve, reject) => { expiryWorker.once('message', () => resolve()); expiryWorker.once('error', reject) })
        expect(Date.now()).toBeLessThan(Date.parse(expiry))
        const expired = (await createSqlAgentInteractionHistory(runtime.db, 'sqlite')(ownerId, 1, { restoreActive: false })).find(row => row.id === 1)
        expect(expired?.resolved).toBe(true); expect(expired?.options).toEqual([])
        expect((await sql<{ token_hash: string }>`SELECT token_hash FROM interaction_actions WHERE id=1`.execute(runtime.db)).rows[0]!.token_hash).toBe(saved.rows[0]!.token_hash)
      } finally { await expiryWorker.terminate() }
      await sql`UPDATE interaction_prompts SET expires_at='2026-01-01T08:00:02+08:00' WHERE id=1`.execute(runtime.db)
      await sql`UPDATE interaction_actions SET expires_at='2026-01-01 00:00:02' WHERE prompt_id=1`.execute(runtime.db)
      const workerCode = `const { parentPort,workerData }=require('node:worker_threads'); const SQLite=require(workerData.sqlite); const db=new SQLite(workerData.path); db.pragma('busy_timeout=5000'); db.exec("BEGIN IMMEDIATE; UPDATE interaction_prompts SET status='resolved' WHERE id=1"); parentPort.postMessage('locked'); setTimeout(()=>{db.exec('COMMIT');db.close();parentPort.postMessage('committed')},300)`
      const worker = new Worker(workerCode, { eval: true, workerData: { sqlite: require.resolve('better-sqlite3'), path } })
      try {
        await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject) })
        const start = Date.now(), afterConsume = await list(ownerId, 1, { restoreActive: true })
        expect(Date.now() - start).toBeGreaterThanOrEqual(100)
        expect(afterConsume.find(row => row.id === 1)?.resolved).toBe(true)
        expect(afterConsume.find(row => row.id === 1)?.options).toEqual([])
        expect((await sql<{ token_hash: string }>`SELECT token_hash FROM interaction_actions WHERE id=1`.execute(runtime.db)).rows[0]!.token_hash).toBe(saved.rows[0]!.token_hash)
      } finally { await worker.terminate() }
      await sql`UPDATE interaction_prompts SET created_at='not-a-time' WHERE id=3`.execute(runtime.db)
      await expect(list(ownerId, 1, { restoreActive: false })).rejects.toMatchObject({ code: 'storage_error', message: '交互时间格式无效' })
    } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
