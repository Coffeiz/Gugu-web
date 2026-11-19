import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunIdentity } from '@gugu/core/agent'
import type { AgentDispatchLease } from '../../src/modules/agent/run/dispatch.js'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from '../../src/modules/agent/tools/confirm.js'

const identity: RunIdentity = { ownerId: 'owner-a', sessionId: '7', runId: 'run-a' }
const lease: AgentDispatchLease = {
  identity, token: 'dispatch-token', fence: 4,
  input: { userMessageId: 9, locale: 'zh-CN', origin: null, accessVersion: 'a'.repeat(64), v: 2, source: 'web' },
  mode: 'start', cancelRequested: false,
}

test('咕咕管理的技能直接删除要求事务内的账号与访问版本仍匹配当前 lease', async () => {
  const tx = {} as never
  let checked = 0
  let epoch: string | null = `12:${lease.input.accessVersion}`
  const confirmation = createWebAgentToolConfirmation({
    lease, action:'delete_skill', pool:{} as never, intents:{} as never,
    async authorize() { throw new Error('必须在业务事务内授权') },
    async authorizeInTransaction(candidate, binding) {
      assert.equal(candidate, tx)
      assert.equal(binding.ownerId, identity.ownerId)
      checked++
      return epoch
    },
    async describe() { throw new Error('直接删除不创建确认提示') },
  })
  const binding = { ...identity, roundId:'round-1', toolCallId:'call-1', toolName:'delete_skill', normalizedInputDigest:'d'.repeat(64) }
  const signal = new AbortController().signal
  assert.equal(await confirmation.authorizeDirect(tx, { ...binding, toolName:'delete_client' }, signal), false)
  assert.equal(await confirmation.authorizeDirect(tx, { ...binding, ownerId:'owner-b' }, signal), false)
  assert.equal(checked, 0)
  assert.equal(await confirmation.authorizeDirect(tx, binding, signal), true)
  epoch = `12:${'b'.repeat(64)}`
  assert.equal(await confirmation.authorizeDirect(tx, binding, signal), false)
  epoch = null
  assert.equal(await confirmation.authorizeDirect(tx, binding, signal), false)
  assert.equal(checked, 3)
})

test('可信确认只对当前活动 owner/run、账号和 fencing dispatch 返回授权版本', async () => {
  let queries = 0, accessReads = 0
  let user = { security_version: 12, is_active: true, account_status: 'active' }
  const authority = createWebAgentConfirmationAuthorization({
    pool: { async query(_query: string, values?: unknown[]) {
      queries++
      assert.deepEqual(values, [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
      return { rows: [{ ...user }], rowCount: 1 } as never
    } },
    lease,
    async accessVersion(candidate) { accessReads++; assert.deepEqual(candidate, identity); return 'provider-access-v1' },
  })
  const binding = { ownerId: identity.ownerId, sessionId: identity.sessionId, runId: identity.runId,
    roundId: 'round-1', toolCallId: 'call-1', toolName: 'delete_event', normalizedInputDigest: 'd'.repeat(64) }
  const signal = new AbortController().signal

  assert.equal(await authority.authorize({ ...binding, ownerId: 'owner-b' }, signal), null)
  assert.equal(queries, 0)
  user = { ...user, is_active: false }
  assert.equal(await authority.authorize(binding, signal), null)
  user = { ...user, is_active: true, account_status: 'suspended' }
  assert.equal(await authority.authorize(binding, signal), null)
  user = { ...user, account_status: 'active' }
  assert.equal(await authority.authorize(binding, signal), '12:provider-access-v1')
  assert.equal(queries, 3)
  assert.equal(accessReads, 1)

  const resumedLease = { ...lease, token: 'resumed-token', fence: lease.fence + 1 }
  const resumed = createWebAgentConfirmationAuthorization({
    pool: { async query(_query: string, values?: unknown[]) {
      assert.deepEqual(values, [identity.ownerId, identity.sessionId, identity.runId, resumedLease.token, resumedLease.fence])
      return { rows: [{ ...user }], rowCount: 1 } as never
    } },
    lease: resumedLease,
    async accessVersion() { return 'provider-access-v1' },
  })
  assert.equal(await resumed.authorize(binding, signal), '12:provider-access-v1')
})

test('可信确认授权尊重运行取消，不读取数据库或 Provider 版本', async () => {
  let reads = 0
  const authority = createWebAgentConfirmationAuthorization({
    pool: { async query() { reads++; return { rows: [], rowCount: 0 } as never } },
    lease,
    async accessVersion() { reads++; return 'provider-access-v1' },
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(authority.authorize({ ownerId: identity.ownerId, sessionId: identity.sessionId,
    runId: identity.runId, roundId: 'round-1', toolCallId: 'call-1', toolName: 'delete_event',
    normalizedInputDigest: 'd'.repeat(64) }, controller.signal), { name: 'AbortError' })
  assert.equal(reads, 0)
})
