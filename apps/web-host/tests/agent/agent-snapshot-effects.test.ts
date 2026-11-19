import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import type { CanonicalRunContext } from '@gugu/core/agent'
import { applyCanonicalSnapshotEffects } from '../../src/modules/agent-sessions/persistence/agent-snapshot-effects-postgres.js'

const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
const context = { identity, historyBaseline: { baselineSeq: 3, baselineHash: 'baseline', snapshotHash: 'before' }, sourceEffects: {
  sessionSnapshot: { expectedEpoch: 4, expectedSnapshotHash: 'before', state: { ...identity, contextEpoch: 5,
    baselineMessageSeq: 3, context: { key: 'value' }, snapshotHash: 'after', sessionInfoHash: null, snapshotExpiresAt: null } },
} } as unknown as CanonicalRunContext

test('快照事务更新使用读取时的 owner、基线和旧快照身份，冲突即拒绝', async () => {
  let called = false
  const client = { query: async (_sql: string, args: unknown[]) => {
    called = true
    assert.deepEqual([args[0], args[1], args[2], args[3], args[9], args[10]], ['owner', '1', 4, 'before', 3, 'baseline'])
    return { rowCount: 1 }
  } } as unknown as PoolClient
  await applyCanonicalSnapshotEffects(client, identity, context)
  assert.equal(called, true)
  await assert.rejects(applyCanonicalSnapshotEffects({ query: async () => ({ rowCount: 0 }) } as unknown as PoolClient, identity, context), /快照已变化/)
  const changed = structuredClone(context)
  changed.historyBaseline!.snapshotHash = 'concurrent'
  await assert.rejects(applyCanonicalSnapshotEffects(client, identity, changed), /来源身份/)
})
