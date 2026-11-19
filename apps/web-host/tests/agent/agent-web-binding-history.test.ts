import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { MessageArea, stableJson } from '@gugu/core/agent'
import type { CanonicalRunContext, RunCheckpoint } from '@gugu/core/agent'
import type { AgentDispatchLease } from '../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import type { AgentRunHistoryWrite } from '../../src/modules/agent-sessions/persistence/agent-run-store-postgres.js'
import { createWebAgentBindingHistory, type WebAgentBinding } from '../../src/modules/agent-sessions/agent-web-reconstructor.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

test('Web 绑定历史 writer 使用同一 Provider 快照记账并拒绝身份漂移', async () => {
  const identity = { ownerId: 'synthetic-owner', sessionId: '19', runId: 'synthetic-run' }
  const lease = { identity } as AgentDispatchLease
  const usageConfig = { defaultLimit6h: 64_000, byokEnabled: true, localDeployment: false,
    model: 'synthetic-model', provider: 'synthetic-provider', isByok: true }
  const binding = { selection: { modelIdentity: 'signed-model-identity' }, usageConfig } as WebAgentBinding
  const area = new MessageArea({ digest, nextId: randomUUID })
  const context = { identity, modelIdentity: binding.selection.modelIdentity, prepared: { area: area.snapshot() },
    compactions: [], continuationRef: null, providerCacheAnchor: null } as unknown as CanonicalRunContext
  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null }
  const checkpoint = { identity, totalUsage: zeroUsage, files: [], displayTimeline: [], providerRounds: [], calls: [] } as unknown as RunCheckpoint<CanonicalRunContext>
  const history: AgentRunHistoryWrite<CanonicalRunContext> = { outcome: 'silent', context, text: '' }
  let recordedConfig: unknown
  const client = { async query(sql: string) {
    if (sql.includes('last_message_seq')) return { rows: [{ last_message_seq: '0' }], rowCount: 1 }
    if (sql.includes('INSERT INTO conversation_batches')) return { rows: [{ id: 1 }], rowCount: 1 }
    if (sql.includes('SELECT u.token_limit_6h')) return { rows: [{ token_limit_6h: null, quota_window_started_at: null }], rowCount: 1 }
    throw new Error(`意外 SQL: ${sql}`)
  } }
  const observed = createWebAgentBindingHistory(lease, { ...binding,
    usageConfig: new Proxy(usageConfig, { get(target, key, receiver) { recordedConfig = target; return Reflect.get(target, key, receiver) } }),
  })
  await observed.writeHistory(client as never, identity, history, checkpoint)
  assert.equal(recordedConfig, usageConfig)

  await assert.rejects(observed.writeHistory(client as never, { ...identity, ownerId: 'other-owner' }, history, checkpoint), /身份不匹配/u)
  await assert.rejects(observed.writeHistory(client as never, identity, { ...history,
    context: { ...context, modelIdentity: 'different-model' } as CanonicalRunContext }, checkpoint), /身份不匹配/u)
})
