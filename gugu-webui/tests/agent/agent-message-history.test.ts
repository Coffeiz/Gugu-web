import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import {
  AgentSessionNotFoundError,
  createAgentMessageHistory,
  projectMessageBodies,
  projectTimelineEvents,
} from '../../src/domains/agent-sessions/persistence/agent-message-history.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('历史投影剥离工具内部输入输出与多媒体载荷', () => {
  const events = projectTimelineEvents([{
    id: 9,
    displayTimeline: [{
      kind: 'tool', toolInput: { secret: '不得回显' },
      toolResult: [{ type: 'video', source: { type: 'base64', data: 'synthetic-bytes' } }],
      timelineOrder: 9001, createdAt: '2026-11-12T00:00:00Z',
    }],
  }]) as Array<Record<string, unknown>>
  assert.equal(events.length, 1)
  assert.equal('toolInput' in events[0]!, false)
  assert.equal('toolResult' in events[0]!, false)
  assert.deepEqual(events[0]!.detailSource, { kind: 'timeline', messageId: 9, index: 0 })
  assert.equal(events[0]!.detailsAvailable, true)
})

test('消息正文只返回展示正文，时间线过大时保留正文并标记省略', () => {
  const base = {
    role: 'assistant', content: '已完成', files: null, run_id: 'run-x', round_id: 'round-x',
    created_at: new Date('2026-11-12T00:00:00Z'), conversation_seq: '1',
  }
  const rows = projectMessageBodies([
    { ...base, id: 1, is_display_body: true, has_display_timeline: false, display_timeline: null },
    { ...base, id: 2, is_display_body: true, has_display_timeline: true, display_timeline: [{ kind: 'assistant' }] },
    { ...base, id: 3, is_display_body: true, has_display_timeline: true, display_timeline: null },
    { ...base, id: 4, is_display_body: false, has_display_timeline: false, display_timeline: null },
  ])
  assert.deepEqual(rows.map(({ id }) => id), [1, 3])
  assert.equal(rows[1]?.timelineOmitted, true)
  assert.equal('contentJson' in rows[0]!, false)
  assert.equal('displayTimeline' in rows[0]!, false)
})

test('QQ 历史仅移除匹配同条附件的占位符并保留不匹配的用户文本', () => {
  const createdAt = new Date('2026-11-12T00:00:00Z')
  const row = {
    role: 'user', is_display_body: true, has_display_timeline: false,
    display_timeline: null, run_id: null, round_id: null, conversation_seq: '1', created_at: createdAt,
  }
  const marker = '<attachmentType="image/jpeg",attachmentIndex=0,description="opaque">'
  const projected = projectMessageBodies([
    { ...row, id: 1, content: marker, files: [{ mime: 'image/jpeg; charset=binary', quoted: false }] },
    { ...row, id: 2, content: marker, files: [{ mime: 'image/png', quoted: false }] },
    { ...row, id: 3, content: marker, files: [{ mime: 'image/jpeg', quoted: true }] },
  ], 'qq')
  assert.deepEqual(projected.map(({ content }) => content), ['', marker, marker])
  assert.equal(projectMessageBodies([
    { ...row, id: 4, content: marker, files: [{ mime: 'image/jpeg', quoted: false }] },
  ], 'web')[0]?.content, marker)
})

test('消息历史按会话来源应用 QQ 附件占位符投影', async () => {
  const marker = '<attachmentType="image/jpeg",attachmentIndex=0,description="opaque">'
  const pool = {
    async query(sql: string) {
      if (sql.includes('FROM conversation_sessions'))
        return { rows: [{ id: 3, source: 'qq' }], rowCount: 1 }
      if (sql.includes('pg_column_size')) return {
        rows: [{
          id: 9, role: 'user', content: marker, is_display_body: true,
          display_timeline: null, has_display_timeline: false,
          files: [{ mime: 'image/jpeg', quoted: false }], conversation_seq: '1',
          run_id: null, round_id: null, created_at: new Date('2026-11-12T00:00:00Z'),
        }],
        rowCount: 1,
      }
      if (sql.includes('SELECT 1 FROM conversation_messages')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM conversation_messages')) return { rows: [{ time_key: '1794441600000' }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
  }
  const page = await createAgentMessageHistory(pool as never).list('owner', 3, {})
  assert.equal(page.messages[0]?.content, '')
})

test('through_id 缺少同会话游标时生成空页，不回退为按 ID 截断', async () => {
  const statements: string[] = []
  const pool = {
    async query(sql: string) {
      statements.push(sql)
      if (sql.includes('FROM conversation_sessions')) return { rows: [{ id: 3 }], rowCount: 1 }
      if (sql.includes('SELECT COALESCE')) return { rows: [], rowCount: 0 }
      if (sql.includes('pg_column_size')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    },
  }
  const page = await createAgentMessageHistory(pool as never).list('owner', 3, { throughId: 999 })
  assert.deepEqual(page.messages, [])
  assert.equal(statements.some((sql) => /WHERE[\s\S]*AND FALSE/.test(sql)), true)
  const pageSql = statements.find((sql) => sql.includes('pg_column_size'))!
  assert.match(pageSql, /display_timeline <> 'null'::jsonb/)
  assert.match(pageSql, /pg_column_size\(message\.display_timeline\) > 1048576/)
  assert.doesNotMatch(pageSql, /SELECT[\s\S]*message\.content_json,/)
})

test('消息历史按可见行分页、旧到新返回，并排除摘要与纯 canonical 工具行', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_agent_history_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE conversation_sessions (
        id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), source text
      );
      CREATE TABLE conversation_messages (
        id serial PRIMARY KEY, session_id integer NOT NULL REFERENCES conversation_sessions(id),
        role text NOT NULL, content text NOT NULL, content_json jsonb, display_timeline jsonb,
        files jsonb, conversation_seq bigint NOT NULL, run_id text, round_id text,
        im_platform_sent_ms bigint, im_event_received_ms bigint, created_at timestamptz NOT NULL
      );
    `)
    const owner = randomUUID(), other = randomUUID()
    await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [owner, other])
    const { rows: [session] } = await pool.query<{ id: number }>(
      'INSERT INTO conversation_sessions (user_id) VALUES ($1) RETURNING id', [owner],
    )
    const { rows: [foreign] } = await pool.query<{ id: number }>(
      'INSERT INTO conversation_sessions (user_id) VALUES ($1) RETURNING id', [other],
    )
    const created = new Date('2026-11-12T00:00:00Z')
    for (let index = 0; index < 4; index++) {
      await pool.query(
        `INSERT INTO conversation_messages (session_id,role,content,conversation_seq,created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [session.id, index % 2 === 0 ? 'user' : 'assistant', `m${index}`, index + 1, new Date(created.getTime() + index * 1000)],
      )
    }
    await pool.query(
      `INSERT INTO conversation_messages (session_id,role,content,content_json,display_timeline,conversation_seq,created_at)
       VALUES ($1,'summary','摘要',NULL,NULL,5,$2),
              ($1,'assistant','工具中间行','[{"type":"tool_use"}]',NULL,6,$3),
              ($1,'assistant','不应作为正文','[{"type":"tool_use"}]','null',7,$4),
              ($1,'assistant','', '[{"type":"tool_use"}]',
               '[{"kind":"tool","toolInput":{"private":"secret"},"toolResult":[{"type":"video","source":{"type":"base64","data":"secret-bytes"}}],"timelineOrder":7001,"createdAt":"2026-11-12T00:00:07Z"}]',8,$5)`,
      [session.id, new Date(created.getTime() + 4000), new Date(created.getTime() + 5000), new Date(created.getTime() + 6000), new Date(created.getTime() + 1500)],
    )
    const history = createAgentMessageHistory(pool)
    const first = await history.list(owner, session.id, { limit: 2 })
    assert.deepEqual(first.messages.map(({ content }) => content), ['m2', 'm3'])
    assert.deepEqual(first.pagination, {
      limit: 2, hasMore: true, hasNewer: false,
      oldestId: first.messages[0]?.id, newestId: first.messages[1]?.id,
    })
    const older = await history.list(owner, session.id, { limit: 10, beforeId: 3 })
    assert.deepEqual(older.messages.map(({ content }) => content), ['m0', 'm1'])
    assert.equal(older.pagination.hasMore, false)
    assert.deepEqual(older.pagination.oldestId, older.messages[0]?.id)
    const all = await history.list(owner, session.id, { limit: 20 })
    assert.deepEqual(all.messages.map(({ content }) => content), ['m0', 'm1', 'm2', 'm3'])
    assert.equal(all.timelineEvents.length, 1)
    assert.equal('toolInput' in (all.timelineEvents[0] as object), false)
    assert.equal('toolResult' in (all.timelineEvents[0] as object), false)
    const absentThroughCursor = await history.list(owner, session.id, { throughId: 9999 })
    assert.deepEqual(absentThroughCursor.messages, [])
    await assert.rejects(
      history.list(owner, foreign.id, {}),
      (error: unknown) => error instanceof AgentSessionNotFoundError && error.statusCode === 404,
    )
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
