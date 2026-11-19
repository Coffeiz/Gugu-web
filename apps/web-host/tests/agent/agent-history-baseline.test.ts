import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import type { CanonicalRunContext } from '@gugu/core/agent'
import { lockCanonicalHistoryBaseline } from '../../src/modules/agent/chat/baseline.js'

const identity = { ownerId: 'synthetic-owner', sessionId: '12', runId: 'synthetic-run' }
const context = { identity, historyBaseline: { baselineSeq: 3, baselineHash: 'old-hash', snapshotHash: 'old-snapshot' },
  sourceEffects: { sessionSnapshot: { state: { snapshotHash: 'new-snapshot', contextEpoch: 4 } } } } as unknown as CanonicalRunContext

function client(row: Record<string, unknown> | null) {
  return { query: async (_sql: string, values: unknown[]) => {
    assert.deepEqual(values, [identity.ownerId, identity.sessionId])
    return { rows: row ? [row] : [] }
  } } as unknown as PoolClient
}

test('事务锁校验基线和已提交的快照身份，拒绝并发变化与跨用户会话', async () => {
  const row = { baseline: '3', baseline_hash: 'old-hash', snapshot_hash: 'new-snapshot', context_epoch: 4 }
  await lockCanonicalHistoryBaseline(client(row), identity, context)
  for (const change of [{ baseline: '4' }, { baseline_hash: 'other' }, { snapshot_hash: 'other' }, { context_epoch: 5 }])
    await assert.rejects(lockCanonicalHistoryBaseline(client({ ...row, ...change }), identity, context), /基线已变化/)
  await assert.rejects(lockCanonicalHistoryBaseline(client(null), identity, context), /基线已变化/)
  await assert.rejects(lockCanonicalHistoryBaseline(client(row), { ...identity, ownerId: 'foreign' }, context), /身份/)
})
