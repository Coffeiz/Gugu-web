import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { AgentRunMigrationError, applyAgentRunMigration, checkAgentRunMigration } from '../../src/migrations/agent-run-migrate.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const integration = { skip: !url && '需要隔离 PostgreSQL' }
const incompatible = (error: unknown) => error instanceof AgentRunMigrationError && error.code === 'incompatible'

async function withSchema(run: (pool: Pool) => Promise<void>) {
  const admin = new Pool({ connectionString: url })
  const schema = `agent_runtime_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer NOT NULL);
      CREATE TABLE interaction_prompts(id integer PRIMARY KEY,user_id uuid NOT NULL,session_id integer NOT NULL)`)
    await run(pool)
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
}

test('Node 调度迁移串行初始化并检查结构，阻止异主或异会话调度', integration, async () => withSchema(async pool => {
  assert.equal(await checkAgentRunMigration(pool), 'pending')
  assert.equal((await pool.query("SELECT to_regclass('gugu_node_agent_run_migrations') AS ledger")).rows[0].ledger, null)
  assert.deepEqual((await Promise.all([applyAgentRunMigration(pool), applyAgentRunMigration(pool)])).sort(), ['applied', 'unchanged'])
  assert.equal(await checkAgentRunMigration(pool), 'applied')
  const owner = randomUUID(), other = randomUUID()
  await pool.query('INSERT INTO users VALUES ($1),($2)', [owner, other])
  await pool.query('INSERT INTO conversation_sessions VALUES(1,$1),(2,$2)', [owner, other])
  await pool.query('INSERT INTO conversation_messages VALUES(11,1),(22,2)')
  const dispatch = (run: string, ownerId: string, message: number) => pool.query(`INSERT INTO agent_run_dispatch
    (user_id,session_id,run_id,state,message_id,nonce,payload,request_expires_at)
    VALUES($1,1,$2,'selected',$3,$4,$4,now())`, [ownerId, run, message, Buffer.alloc(0)])
  await assert.rejects(dispatch('wrong-owner', other, 11), { code: '23503' })
  await assert.rejects(dispatch('wrong-session', owner, 22), { code: '23503' })
  await dispatch('allowed', owner, 11)
  await assert.rejects(dispatch('second-selected', owner, 11), { code: '23505' })
  await pool.query('DELETE FROM conversation_messages WHERE id=11')
  assert.equal((await pool.query('SELECT 1 FROM agent_run_dispatch')).rowCount, 0)
  await pool.query('INSERT INTO interaction_prompts VALUES(51,$1,1),(52,$2,2)', [owner, other])
  await pool.query(`INSERT INTO agent_run_checkpoints
    (user_id,session_id,run_id,version,sequence,status,phase,nonce,payload,created_at,updated_at)
    VALUES($1,1,'allowed',1,0,'waiting','tools',$2,$2,now(),now())`, [owner, Buffer.alloc(0)])
  const bind = (prompt: number) => pool.query(`INSERT INTO agent_interaction_bindings
    (user_id,session_id,run_id,prompt_id,interaction_id,tool_call_id)
    VALUES($1,1,'allowed',$2,'interaction','tool')`, [owner, prompt])
  await assert.rejects(bind(52), { code: '23503' })
  await bind(51)
  await pool.query(`INSERT INTO agent_interaction_resumes
    (user_id,session_id,run_id,prompt_id,interaction_id,receipt,created_at)
    VALUES($1,1,'allowed',51,'interaction','receipt',now())`, [owner])
  await pool.query('DELETE FROM interaction_prompts WHERE id=51')
  assert.equal((await pool.query('SELECT 1 FROM agent_interaction_resumes')).rowCount, 0)
  await pool.query('DROP INDEX uq_agent_dispatch_selected')
  await assert.rejects(checkAgentRunMigration(pool), incompatible)
}))

test('未登记表会阻止迁移，建表失败时回滚已经创建的对象', integration, async () => withSchema(async pool => {
  await pool.query('CREATE TABLE agent_run_dispatch(id integer)')
  await assert.rejects(applyAgentRunMigration(pool), incompatible)
  await pool.query('DROP TABLE agent_run_dispatch')
  await pool.query('ALTER TABLE interaction_prompts DROP COLUMN session_id')
  await assert.rejects(applyAgentRunMigration(pool), AgentRunMigrationError)
  const { rows } = await pool.query(`SELECT to_regclass('gugu_agent_session_owner') AS owner_index,
    to_regclass('gugu_node_agent_run_migrations') AS ledger,to_regclass('agent_run_startups') AS startup`)
  assert.deepEqual(rows, [{ owner_index: null, ledger: null, startup: null }])
}))
