import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunIdentity } from '@gugu/core/agent'
import type { AgentDispatchLease } from '../../src/modules/agent/run/dispatch.js'
import { createPostgresWebAgentMemorySnapshotReader, createWebAgentMemoryAuthorizer } from '../../src/modules/agent/rag/run.js'

const lease: AgentDispatchLease = {
  identity: { ownerId: 'owner-a', sessionId: '17', runId: 'run-a' },
  token: 'synthetic-lease', fence: 3, mode: 'start', cancelRequested: false,
  input: { userMessageId: 91, locale: 'zh-CN', origin: null, accessVersion: 'a'.repeat(64), v: 2, source: 'web' },
}
const identity: RunIdentity = lease.identity

test('生产 Web memory 授权绑定当前 Run、配置名称、Registry grant 与 owner scope', async () => {
  let configuredNames: readonly string[] = ['search_memory']
  let grantedNames: readonly string[] = ['search_memory']
  let activeRunId = 'run-a', configReads = 0, capabilityReads = 0, activeChecks = 0
  const authorize = createWebAgentMemoryAuthorizer({ async query(_sql: string, values?: unknown[]) {
    activeChecks++
    assert.deepEqual(values, ['owner-a', '17', 'run-a'])
    return { rows: activeRunId === values?.[2] ? [{ active_run_id: activeRunId }] : [] }
  } } as never, lease,
    { async capabilities(input) { capabilityReads++; assert.deepEqual(input, identity); return grantedNames.map(name => ({ name } as never)) } },
    { async configuration(input) {
      configReads++
      assert.deepEqual(input, identity)
      return { identity: { ownerId: 'owner-a', subject: { kind: 'session', id: '17' }, workspaceId: null }, source: 'web', toolNames: configuredNames }
    } },
  )

  assert.equal(await authorize(identity, new AbortController().signal, [{ ownerId: 'owner-a', type: 'owner', id: 'owner-a' }]), true)
  assert.equal(configReads, 1)
  assert.equal(capabilityReads, 1)
  assert.equal(await authorize({ ...identity, runId: 'other-run' }, new AbortController().signal), false)
  assert.equal(await authorize(identity, new AbortController().signal, [{ ownerId: 'owner-b', type: 'owner', id: 'owner-b' }]), false)
  assert.equal(await authorize(identity, new AbortController().signal, [{ ownerId: 'owner-a', type: 'group', id: 'group-a' }]), false)
  configuredNames = []
  assert.equal(await authorize(identity, new AbortController().signal), false)
  configuredNames = ['search_memory']
  grantedNames = []
  assert.equal(await authorize(identity, new AbortController().signal), false)
  grantedNames = ['search_memory']
  activeRunId = 'replacement-run'
  assert.equal(await authorize(identity, new AbortController().signal), false)
  assert.equal(activeChecks, 4)
})

test('memory snapshot 只读 owner/session/active-run 快照且保留版本与正文', async () => {
  const calls: unknown[][] = []
  const reader = createPostgresWebAgentMemorySnapshotReader({ async query(_sql: string, values?: unknown[]) {
    calls.push(values ?? [])
    return { rows: [{ active_run_id: 'run-a', context_epoch: 6, session_context: {
      rag_revision: 'snapshot-r17', snapshot_context: '当前轮已注入的稳定记忆摘要',
    } }] }
  } } as never, lease)

  assert.deepEqual(await reader(identity, new AbortController().signal), {
    revision: '6:snapshot-r17', text: '当前轮已注入的稳定记忆摘要',
  })
  assert.deepEqual(calls, [['owner-a', '17', 'run-a']])
  await assert.rejects(reader({ ...identity, ownerId: 'owner-b' }, new AbortController().signal), /身份不匹配/u)

  const stale = createPostgresWebAgentMemorySnapshotReader({ async query() {
    return { rows: [{ active_run_id: 'another-run', context_epoch: 6, session_context: { rag_revision: 'r1', snapshot_context: '' } }] }
  } } as never, lease)
  await assert.rejects(stale(identity, new AbortController().signal), /当前会话不可用/u)
  const damaged = createPostgresWebAgentMemorySnapshotReader({ async query() {
    return { rows: [{ active_run_id: 'run-a', context_epoch: 6, session_context: { snapshot_context: '' } }] }
  } } as never, lease)
  await assert.rejects(damaged(identity, new AbortController().signal), /会话版本无效/u)

  const controller = new AbortController(); controller.abort()
  await assert.rejects(reader(identity, controller.signal), { name: 'AbortError' })
})
