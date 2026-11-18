import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostgresAgentRunStartupStore } from '../../src/domains/agent-sessions/persistence/agent-run-startup-postgres.js'
const owner = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
function setup() {
  const entries = new Map<string, string>(); let activeLease = false, checkpoint = false
  const query = async (sql: string, args: unknown[] = []) => {
    const key = JSON.stringify(args)
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rowCount: null, rows: [] }
    if (sql.startsWith('SELECT id FROM conversation_sessions')) return { rowCount: args[0] === 'owner-a' && args[1] === 1 ? 1 : 0, rows: [] }
    if (sql.includes('INSERT INTO agent_run_startups')) { if (entries.has(key)) return { rowCount: 0, rows: [] }; entries.set(key, 'pending'); return { rowCount: 1, rows: [] } }
    if (sql.includes('UPDATE agent_run_startups')) { if (entries.get(key) !== 'pending' || checkpoint || activeLease) return { rowCount: 0, rows: [] }; entries.set(key, 'failed'); return { rowCount: 1, rows: [] } }
    if (sql.startsWith('SELECT 1 FROM agent_run_startups')) return { rowCount: entries.get(key) === 'failed' ? 1 : 0, rows: [] }
    throw new Error('unexpected query')
  }
  const client = { query, release() {} }, pool = { query, connect: async () => client }
  return { store: createPostgresAgentRunStartupStore(pool as never), setLease: (v: boolean) => { activeLease = v }, setCheckpoint: (v: boolean) => { checkpoint = v } }
}
test('只允许登记过的归属 run 在无活动租约或 checkpoint 时标记失败', async () => {
  const { store, setLease, setCheckpoint } = setup()
  assert.equal(await store.failStart(owner), false)
  assert.equal(await store.register({ ...owner, ownerId: 'owner-b' }), false)
  assert.equal(await store.register(owner), true)
  setLease(true); assert.equal(await store.failStart(owner), false)
  setLease(false); setCheckpoint(true); assert.equal(await store.failStart(owner), false)
  setCheckpoint(false); assert.equal(await store.failStart(owner), true)
  assert.equal(await store.readFailure(owner), true)
  assert.equal(await store.readFailure({ ...owner, runId: 'run-b' }), false)
})
