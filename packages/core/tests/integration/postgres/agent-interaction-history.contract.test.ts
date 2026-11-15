import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { expect, it } from 'vitest'
import { createSqlAgentInteractionHistory } from '../../../src/agent/sessions/interaction-history.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
it('交互历史事务只返回已提交令牌，保持 owner、窗口和旧 JSON 语义', async () => {
  const schema = `gugu_hist_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), other = randomUUID()
  const admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) })
  try {
    await pool.query(`CREATE TABLE interaction_prompts(id integer PRIMARY KEY,user_id uuid,session_id integer,kind text,title text,body text,schema_json jsonb,status text,expires_at timestamptz,created_at timestamptz);
      CREATE TABLE interaction_actions(id integer PRIMARY KEY,prompt_id integer,option_id text,status text,expires_at timestamptz,token_hash text)`)
    const now = new Date('2026-01-01T00:00:01.000Z')
    const body = { options: [{ id: 5, label: '' }], secret_fields: [], context: { tool_call_id: 77, secret_target: { kind: 'mcp_credentials' } } }
    const legacy = { context: { tool_call_id: 'legacy' }, resolved_result: { text: '已处理' } }
    await pool.query(`INSERT INTO interaction_prompts VALUES
      (1,$1,7,'confirm','活动','内容',$3,'active','2026-01-02','2026-01-01 00:00:00.123456+00'),
      (2,$1,7,'confirm','历史','内容',$4,'resolved','2026-01-01','2026-01-01 00:00:00.123456+00'),
      (3,$2,7,'confirm','他人','内容',$3,'active','2026-01-02','2026-01-01'),
      (4,$1,7,'confirm','旧字符串','内容',$5,'resolved','2026-01-01','2026-01-01 00:00:00.123457+00'),
      (5,$1,7,'confirm','数字工具 ID','内容','{"context":{"tool_call_id":9007199254740993}}'::jsonb,'resolved','2026-01-01','2026-01-01 00:00:00.123458+00')`, [owner, other, JSON.stringify(body), JSON.stringify(legacy), JSON.stringify(JSON.stringify(legacy))])
    await pool.query("INSERT INTO interaction_actions VALUES (1,1,'5','pending','2026-01-02','old'),(2,2,'5','consumed','2026-01-01','old'),(3,1,'other','pending','2026-01-02','old')")
    const list = createSqlAgentInteractionHistory(db, 'postgres', () => now)
    const rows = await list(owner, 7, { restoreActive: true })
    expect(rows.map(row => row.id)).toEqual([1, 2, 4, 5])
    expect(rows[0]?.tool_call_id).toBe('77'); expect(rows[0]?.options[0]?.label).toBe('')
    const token = rows[0]!.options[0]!.token
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const stored = await pool.query<{ token_hash: string }>('SELECT token_hash FROM interaction_actions WHERE id=1')
    expect(stored.rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(rows[2]?.tool_call_id).toBe('legacy')
    const base = Date.parse('2026-01-01T00:00:00.123Z')
    const page = await list(owner, 7, { restoreActive: false, startAtMs: `${base}.456`, endBeforeMs: `${base}.457` })
    expect(page.map(row => row.id)).toEqual([2])
    await pool.query("INSERT INTO interaction_actions VALUES (5,5,'irrelevant','pending','2026-01-02','old')")
    const windowLock = await pool.connect()
    try {
      await windowLock.query('BEGIN')
      await windowLock.query('SELECT id FROM interaction_prompts WHERE id=5 FOR UPDATE')
      await windowLock.query('SELECT id FROM interaction_actions WHERE id=5 FOR UPDATE')
      expect((await list(owner, 7, { restoreActive: false, startAtMs: `${base}.456`, endBeforeMs: `${base}.457` })).map(row => row.id)).toEqual([2])
      await windowLock.query('ROLLBACK')
      await windowLock.query('BEGIN')
      await windowLock.query('SELECT id FROM interaction_prompts WHERE id=2 FOR UPDATE')
      await expect(list(owner, 7, { restoreActive: false, startAtMs: `${base}.456`, endBeforeMs: `${base}.457` })).rejects.toMatchObject({ code: 'conflict' })
    } finally { await windowLock.query('ROLLBACK'); windowLock.release() }
    expect((await list(owner, 7, { restoreActive: false, toolCallIds: ['legacy'] })).map(row => row.id)).toEqual([2])
    const largeId = await list(owner, 7, { restoreActive: false, toolCallIds: ['9007199254740993'] })
    expect(largeId.map(row => row.id)).toEqual([5]); expect(largeId[0]?.tool_call_id).toBe('9007199254740993')
    const expiryBlocker = await pool.connect()
    try {
      await expiryBlocker.query('BEGIN')
      await expiryBlocker.query('SELECT id FROM interaction_actions WHERE id=1 FOR UPDATE')
      let time = now
      const afterExpiry = createSqlAgentInteractionHistory(db, 'postgres', () => time)(owner, 7, { restoreActive: false, startAtMs: `${base}.456`, endBeforeMs: `${base}.457` })
      let blocked = false
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const state = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM interaction_actions%'")
        blocked = Number(state.rows[0]!.count) > 0
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(blocked).toBe(true)
      time = new Date('2026-01-03T00:00:00Z')
      await expiryBlocker.query('COMMIT')
      const expired = (await afterExpiry).find(row => row.id === 1)
      expect(expired?.resolved).toBe(true); expect(expired?.options).toEqual([])
      expect((await pool.query<{ token_hash: string }>('SELECT token_hash FROM interaction_actions WHERE id=1')).rows[0]!.token_hash).toBe(stored.rows[0]!.token_hash)
    } finally { await expiryBlocker.query('ROLLBACK').catch(() => undefined); expiryBlocker.release() }
    const consuming = await pool.connect()
    try {
      await consuming.query('BEGIN')
      await consuming.query('SELECT id FROM interaction_actions WHERE id=1 FOR UPDATE')
      const waiting = list(owner, 7, { restoreActive: true })
      let locked = false
      for (let attempt = 0; attempt < 100 && !locked; attempt++) {
        const state = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM interaction_actions%'")
        locked = Number(state.rows[0]!.count) > 0
        if (!locked) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(locked).toBe(true)
      await consuming.query("UPDATE interaction_prompts SET status='resolved' WHERE id=1")
      await consuming.query('COMMIT')
      const refreshed = await waiting
      const resolved = refreshed.find(row => row.id === 1)
      expect(resolved?.resolved).toBe(true); expect(resolved?.options).toEqual([])
      expect((await pool.query<{ token_hash: string }>('SELECT token_hash FROM interaction_actions WHERE id=1')).rows[0]!.token_hash).toBe(stored.rows[0]!.token_hash)
    } finally { await consuming.query('ROLLBACK').catch(() => undefined); consuming.release() }
    await pool.query("UPDATE interaction_prompts SET status='active' WHERE id=1")
    // Node 写入方先持有 prompt，并等待 history 已持有的 action。
    let notifyLocked!: () => void, releaseHistory!: () => void
    const lockedActions = new Promise<void>(resolve => { notifyLocked = resolve })
    const historyGate = new Promise<void>(resolve => { releaseHistory = resolve })
    let first = true
    const wrappedPool = {
      connect: async () => {
        const client = await pool.connect()
        return {
          query: async (...args: any[]) => {
            const result = await (client.query as any)(...args)
            if (first && typeof args[0] === 'string' && args[0].includes('FROM interaction_actions') && args[0].includes('FOR UPDATE')) {
              first = false; notifyLocked(); await historyGate
            }
            return result
          },
          release: () => client.release(),
        }
      },
      end: async () => undefined,
    }
    const gatedDb = new Kysely<any>({ dialect: new PostgresDialect({ pool: wrappedPool as any }) })
    const nodeWriter = await pool.connect()
    try {
      await nodeWriter.query('BEGIN')
      await nodeWriter.query('SELECT id FROM interaction_prompts WHERE id=1 FOR UPDATE')
      const pendingHistory = createSqlAgentInteractionHistory(gatedDb, 'postgres', () => now)(owner, 7, { restoreActive: true })
      await lockedActions
      const pendingAction = nodeWriter.query("UPDATE interaction_actions SET status='consumed' WHERE id=1")
      let blocked = false
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const state = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%UPDATE interaction_actions SET status=%'")
        blocked = Number(state.rows[0]!.count) > 0
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(blocked).toBe(true)
      releaseHistory()
      await pendingAction
      await nodeWriter.query("UPDATE interaction_prompts SET status='resolved' WHERE id=1")
      await nodeWriter.query('COMMIT')
      const after = (await pendingHistory).find(row => row.id === 1)
      expect(after?.resolved).toBe(true); expect(after?.options).toEqual([]); expect(after?.selected_option_id).toBe('5')
    } finally { releaseHistory(); await nodeWriter.query('ROLLBACK').catch(() => undefined); nodeWriter.release(); await gatedDb.destroy() }
    await pool.query("UPDATE interaction_prompts SET status='active' WHERE id=1")
    await pool.query("UPDATE interaction_actions SET status='pending' WHERE id=1")
    const [refreshA, refreshB] = await Promise.all([list(owner, 7, { restoreActive: true }), list(owner, 7, { restoreActive: true })])
    const refreshTokens = [refreshA, refreshB].map(rows => rows.find(row => row.id === 1)!.options[0]!.token)
    expect(refreshTokens[0]).not.toBe(refreshTokens[1])
    const currentHash = (await pool.query<{ token_hash: string }>('SELECT token_hash FROM interaction_actions WHERE id=1')).rows[0]!.token_hash
    expect(refreshTokens.map(value => createHash('sha256').update(value).digest('hex'))).toContain(currentHash)
    const heldPrompt = await pool.connect()
    try {
      await heldPrompt.query('BEGIN')
      await heldPrompt.query('SELECT id FROM interaction_prompts WHERE id=1 FOR UPDATE')
      await expect(list(owner, 7, { restoreActive: true })).rejects.toMatchObject({ code: 'conflict', message: '交互正在更新，请稍后重试' })
      expect((await pool.query<{ token_hash: string }>('SELECT token_hash FROM interaction_actions WHERE id=1')).rows[0]!.token_hash).toBe(currentHash)
    } finally { await heldPrompt.query('ROLLBACK'); heldPrompt.release() }
    let updates = 0
    const uncertainPool = {
      connect: async () => {
        const client = await pool.connect()
        return { query: async (...args: any[]) => {
          const text = typeof args[0] === 'string' ? args[0] : ''
          if (text.includes('UPDATE interaction_actions SET token_hash=')) updates++
          const result = await (client.query as any)(...args)
          if (text.toLowerCase() === 'commit') throw new Error('synthetic unknown commit')
          return result
        }, release: () => client.release() }
      }, end: async () => undefined,
    }
    const uncertainDb = new Kysely<any>({ dialect: new PostgresDialect({ pool: uncertainPool as any }) })
    try {
      await expect(createSqlAgentInteractionHistory(uncertainDb, 'postgres', () => now)(owner, 7, { restoreActive: true })).rejects.toThrow('synthetic unknown commit')
      expect(updates).toBe(2)
    } finally { await uncertainDb.destroy() }
    const beforeRollback = (await pool.query<{ token_hash: string }>('SELECT token_hash FROM interaction_actions WHERE id=1')).rows[0]!.token_hash
    await pool.query(`CREATE FUNCTION fail_token() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id=3 THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END$$`)
    await pool.query('CREATE TRIGGER fail_token BEFORE UPDATE ON interaction_actions FOR EACH ROW EXECUTE FUNCTION fail_token()')
    await expect(list(owner, 7, { restoreActive: true })).rejects.toThrow()
    expect((await pool.query<{ token_hash: string }>('SELECT token_hash FROM interaction_actions WHERE id=1')).rows[0]!.token_hash).toBe(beforeRollback)
  } finally { await db.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
