import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import type { CanonicalRunContext, RunCheckpoint, RunEvent } from '@gugu/core/agent'
import { createAgentRunCodec } from '@gugu/core/agent/run/codec'
import type { AgentDispatchLease } from '../../../../src/modules/agent/run/dispatch.js'
import type { WebAgentBinding } from '../../../../src/modules/agent/run/reconstruct.js'
import { AgentRunReconstructionVersionError as AgentReconstructionVersionError } from '@gugu/core/agent'
import { createPostgresImAccess } from '../../../../src/modules/im/gateway/inbound/access.js'
import { createImAgentReconstructor, followCommittedImEvents, type ImAgentReconstructorOptions } from '../../../../src/modules/im/gateway/agent/reconstruct.js'
import { createImGroupReplyGate } from '../../../../src/modules/im/gateway/attention/gate.js'
import type { ImAttentionRecord } from '@gugu/core/im/attention/directive'
import { createChooseNoReplyTool } from '@gugu/core/tools'
import { AgentDispatchDeferredError } from '@gugu/core/agent'

const owner = '00000000-0000-4000-8000-000000000081'
const secret = 'synthetic-reconstruction-secret'
const accessVersion = 'a'.repeat(64)
const identity = { ownerId: owner, sessionId: '1', runId: 'synthetic-run' }

test('IM 停在发送首条时 Agent 仍能提交后续事件，恢复后按持久顺序读取', async () => {
  let continueProducing!: () => void
  const ready = new Promise<void>(resolve => { continueProducing = resolve })
  const saved: RunEvent[] = []
  async function* source() {
    for (const sequence of [1, 2, 3]) {
      const event: RunEvent = { identity, id: String(sequence), sequence, round: 1, type: 'token', payload: {} }
      saved.push(event)
      yield event
      if (sequence === 1) await ready
    }
  }
  const { events, producer } = followCommittedImEvents(source(), async () => 0,
    async cursor => saved.filter(event => event.sequence > cursor).slice(0, 1))
  const consumer = events[Symbol.asyncIterator]()
  assert.equal((await consumer.next()).value?.sequence, 1)
  continueProducing()
  await producer
  assert.equal(saved.length, 3)
  assert.equal((await consumer.next()).value?.sequence, 2)
  assert.equal((await consumer.next()).value?.sequence, 3)
  assert.equal((await consumer.next()).done, true)
})
const lease = (): AgentDispatchLease => ({ identity, token: 'synthetic-lease', fence: 1, mode: 'start', cancelRequested: false,
  input: { v: 3, source: 'im', userMessageId: 7, locale: 'zh-CN', origin: null, accessVersion,
    im: { platform: 'telegram', botId: '81', chatType: 'c2c', chatId: null, platformUserId: 'synthetic-owner' } } })

/** 仅重建前置边界：PG 查询和业务资源是明确替身，不启动 Runner、Provider 或真实数据库。 */
function fixture(overrides: Pick<ImAgentReconstructorOptions, 'verifyPendingAsk'> = {}) {
  let enabled = true, anchor = true, releases = 0, binds = 0, resourcesCalls = 0
  let checkpoint: { version: number; nonce: Buffer; payload: Buffer } | null = null
  let route: Awaited<ReturnType<ImAgentReconstructorOptions['readRoute']>> = {
    binding: { ownerId: owner, botId: '81', platform: 'telegram' },
    payload: { owner_user_id: owner, bot_id: '81', platform: 'telegram', platform_user_id: 'synthetic-owner', chat_type: 'c2c' },
  }
  const queries: unknown[][] = []
  const cancellationAttempts: unknown[][] = []
  let cancellationOwned = true
  let policy: Record<string, unknown> | null = { group_requires_at: false, group_read_enabled: false, group_attention_mode: 'natural', group_attention_config_version: 2 }
  let policyFailure = false
  const pool = { async query(sql: string, parameters: unknown[]) {
    queries.push(parameters)
    if (sql.startsWith('SELECT b.group_requires_at,b.group_read_enabled,b.group_attention_mode,b.group_attention_config_version')) {
      if (policyFailure) throw new Error('synthetic-private-sql')
      return { rowCount: policy ? 1 : 0, rows: policy ? [policy] : [] }
    }
    if (sql.startsWith('UPDATE agent_run_dispatch SET cancel_requested=true')) {
      cancellationAttempts.push(parameters)
      return { rowCount: cancellationOwned ? 1 : 0, rows: cancellationOwned ? [{ run_id: identity.runId }] : [] }
    }
    if (sql.includes('FROM conversation_messages')) return { rowCount: anchor ? 1 : 0, rows: anchor ? [{}] : [] }
    if (sql.includes('FROM agent_run_checkpoints')) return { rowCount: checkpoint ? 1 : 0, rows: checkpoint ? [checkpoint] : [] }
    throw new Error('测试未声明的数据库路径')
  } } as unknown as Pool
  const access = createPostgresImAccess({ supportedPlatforms: () => ['telegram'], async query() {
    return { rows: enabled ? [{ id: '81', owner_id: owner, platform: 'telegram', enabled: true, is_active: true,
      account_status: 'active', owner_platform_user_id: 'synthetic-owner', group_allowed_tools: null, group_owner_memory_enabled: false,
      group_chat_enabled: true, feishu_group_chat_enabled: null }] : [] }
  } })
  const selection: WebAgentBinding['selection'] = { modelIdentity: 'synthetic-model', contextWindow: 8192, locale: 'zh-CN', groupChat: false,
    workspaceBinding: null, contextScopeKey: accessVersion, contextPolicy: { memoryEnabled: false, loadOwnerContext: true } }
  let bound = true
  let resource: ImAgentReconstructorOptions['resources'] = async () => null
  const binding: WebAgentBinding = { selection, usageConfig: {} as WebAgentBinding['usageConfig'],
    async resolve() { throw new Error('边界测试不应解析 Provider') }, release() { releases++ } }
  const reconstruct = createImAgentReconstructor({ pool, deliveryPool: { async connect() { throw new Error('前置边界不应取得投递连接') } }, secretKey: secret,
    redis: {} as ImAgentReconstructorOptions['redis'], subscribe: async () => { throw new Error('边界测试不应订阅 Redis') },
    history: { async writeHistory() { throw new Error('边界测试不应写入历史') } }, access,
    async readRoute() { return route }, async readReconstructionStatus() { return null },
    verifyPendingAsk: overrides.verifyPendingAsk,
    async bind() { binds++; return bound ? binding : null },
    async resources(...args) { resourcesCalls++; return resource(...args) }, diagnose() {},
  })
  return { reconstruct, selection, queries, binding, access, cancellationAttempts,
    policy(patch: Record<string, unknown> | null) { policy = patch === null ? null : { ...policy, ...patch } },
    failPolicy() { policyFailure = true },
    loseCancellationOwnership() { cancellationOwned = false },
    counts: () => ({ releases, binds, resourcesCalls }), disable: () => { enabled = false }, missingAnchor: () => { anchor = false },
    missingRoute: () => { route = null }, alterRoute: (patch: Record<string, unknown>) => { Object.assign(route!.payload, patch) },
    noBinding: () => { bound = false }, resources: (value: typeof resource) => { resource = value },
    checkpoint(modelIdentity: string) {
      // 真正 codec 的加密/解密和 owner/session/run AAD 参与测试；仅 context 版本投影是合成值。
      const value = { identity, version: 1, sequence: 0,
        context: { modelIdentity } as CanonicalRunContext } as RunCheckpoint<CanonicalRunContext>
      checkpoint = { version: 1, ...createAgentRunCodec(secret).encryptCheckpoint(value) }
    },
  }
}

test('IM 重建拒绝 Web 或畸形来源，未读取路由前不绑定任何资源', async () => {
  for (const input of [{ ...lease().input, v: 2, source: 'web' }, { ...lease().input, source: 'web' }]) {
    const f = fixture()
    await assert.rejects(f.reconstruct({ ...lease(), input } as AgentDispatchLease), AgentReconstructionVersionError)
    assert.deepEqual(f.counts(), { releases: 0, binds: 0, resourcesCalls: 0 })
    assert.equal(f.queries.length, 0)
  }
})

const attention: ImAttentionRecord = { v: 1, disposition: 'run', mode: 'natural', configVersion: 2,
  subjectEventId: '1791000000000-1', sourceAttentionKind: 'CAPABILITY_ACTION', proactive: false, replyChoice: 'pending' }
function groupAttentionLease(): AgentDispatchLease {
  const candidate = lease()
  if (candidate.input.v !== 3) throw new Error('测试必须使用v3')
  candidate.input.im = { ...candidate.input.im, chatType: 'group', chatId: 'synthetic-group', attention: { ...attention } }
  return candidate
}
function groupRoute() {
  return { chat_type: 'group', chat_id: 'synthetic-group', _node_attention: { ...attention }, _node_stream_event_id: attention.subjectEventId }
}

test('自动群attention必须与密封路由逐字段一致且subject由唯一原始stream事实证明', async () => {
  const variants = [
    { _node_attention: undefined }, { _node_attention: { ...attention, configVersion: 3 } },
    { _node_attention: { ...attention, mode: 'active' } }, { _node_attention: { ...attention, subjectEventId: '1791000000000-2' } },
    { _node_stream_event_id: undefined }, { _node_stream_event_id: '1791000000000-2' },
  ]
  for (const patch of variants) {
    const f = fixture(); f.alterRoute({ ...groupRoute(), ...patch })
    await assert.rejects(f.reconstruct(groupAttentionLease()), AgentReconstructionVersionError)
    assert.equal(f.counts().binds, 0)
  }
  const valid = fixture(); valid.alterRoute(groupRoute()); valid.selection.groupChat = true
  valid.selection.contextPolicy = { memoryEnabled: false, loadOwnerContext: false }
  assert.equal(await valid.reconstruct(groupAttentionLease()), null)
  assert.equal(valid.counts().binds, 1)
  const undeclared = fixture(); undeclared.alterRoute(groupRoute())
  const noAttention = groupAttentionLease(); if (noAttention.input.v !== 3) throw new Error('测试版本错误'); delete noAttention.input.im.attention
  await assert.rejects(undeclared.reconstruct(noAttention), AgentReconstructionVersionError)
  assert.equal(undeclared.counts().binds, 0)
})

test('批次subject必须唯一命中原密封消息而非aggregate或批次eventIds，非末条subject仍可验证', async () => {
  const batch = { batchKey: 'b'.repeat(64), segmentKey: 'c'.repeat(64), messageIds: [9, 7] }
  const first = { owner_user_id: owner, bot_id: '81', platform: 'telegram', chat_type: 'group', chat_id: 'synthetic-group',
    platform_user_id: 'synthetic-member', _node_stream_event_id: attention.subjectEventId }
  const last = { ...first, platform_user_id: 'synthetic-owner', _node_stream_event_id: '1791000000000-2' }
  for (const facts of [[{ ...first, _node_stream_event_id: undefined }, last], [first, { ...last, _node_stream_event_id: attention.subjectEventId }]]) {
    const f = fixture(), candidate = groupAttentionLease(); if (candidate.input.v !== 3) throw new Error('测试版本错误'); candidate.input.im.batch = batch
    f.alterRoute({ ...groupRoute(), _inbound_batch: { ...batch, eventIds: [attention.subjectEventId, '1791000000000-2'] }, _batch_messages: facts })
    await assert.rejects(f.reconstruct(candidate), AgentReconstructionVersionError); assert.equal(f.counts().binds, 0)
  }
  const f = fixture(), candidate = groupAttentionLease(); if (candidate.input.v !== 3) throw new Error('测试版本错误'); candidate.input.im.batch = batch
  f.alterRoute({ ...groupRoute(), _inbound_batch: batch, _batch_messages: [first, last] })
  f.selection.groupChat = true; f.selection.contextPolicy = { memoryEnabled: false, loadOwnerContext: false }
  assert.equal(await f.reconstruct(candidate), null); assert.equal(f.counts().binds, 1)
})

test('attention不能进入私聊、微信或非run派发，错误来源在模型绑定前拒绝', async () => {
  for (const im of [{ chatType: 'c2c', chatId: null }, { platform: 'wechat' },
    { attention: { ...attention, disposition: 'pending', replyChoice: 'reply' } },
    { attention: { ...attention, disposition: 'passive', replyChoice: 'reply' } }]) {
    const f = fixture(), candidate = groupAttentionLease(); if (candidate.input.v !== 3) throw new Error('测试版本错误')
    Object.assign(candidate.input.im, im); f.alterRoute(groupRoute())
    await assert.rejects(f.reconstruct(candidate), AgentReconstructionVersionError); assert.equal(f.counts().binds, 0)
  }
})

test('延迟ASK缺少真实证明端口或返回非法状态时模型绑定前拒绝', async () => {
  for (const f of [fixture(), fixture({ async verifyPendingAsk() { return 'invalid' as never } })]) {
    f.alterRoute({ ...groupRoute(), _node_pending_ask_resume_id: 'synthetic-resume-receipt' })
    await assert.rejects(f.reconstruct(groupAttentionLease()), AgentReconstructionVersionError)
    assert.equal(f.counts().binds, 0); assert.equal(f.queries.length, 0)
  }
})

test('真实策略不再匹配时仅对当前owner/session/Run/token/fence请求持久取消；失租不进入模型绑定', async () => {
  for (const patch of [{ group_attention_config_version: 3 }, { group_requires_at: true }, { group_read_enabled: true }, { group_attention_mode: 'quiet' }, null]) {
    for (const owned of [true, false]) {
      const f = fixture(); f.alterRoute(groupRoute()); f.policy(patch)
      f.selection.groupChat = true; f.selection.contextPolicy = { memoryEnabled: false, loadOwnerContext: false }
      if (!owned) f.loseCancellationOwnership()
      if (owned) assert.equal(await f.reconstruct(groupAttentionLease()), null)
      else { await assert.rejects(f.reconstruct(groupAttentionLease()), AgentDispatchDeferredError); assert.equal(f.counts().binds, 0) }
      assert.deepEqual(f.cancellationAttempts, [[owner, identity.sessionId, identity.runId, 'synthetic-lease', 1]])
    }
  }
})

test('策略SQL故障保留重试，不伪作撤权取消或绑定模型，错误不泄露底层SQL', async () => {
  const f = fixture(); f.alterRoute(groupRoute()); f.failPolicy()
  await assert.rejects(f.reconstruct(groupAttentionLease()), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, 'IM 自动回复策略暂时不可用'); assert.equal(error.cause, undefined)
    assert.doesNotMatch(error.stack ?? '', /synthetic-private-sql/); assert.doesNotMatch(JSON.stringify(error), /synthetic-private-sql/)
    return true
  })
  assert.deepEqual(f.cancellationAttempts, []); assert.equal(f.counts().binds, 0); assert.equal(f.counts().resourcesCalls, 0)
})

test('延迟ASK取消只写领取lease的owner/session/Run/token/fence；失去归属保持deferred不绑定模型', async () => {
  for (const owned of [true, false]) {
    let verified = 0
    const f = fixture({ async verifyPendingAsk(id, payload, signal) {
      verified++; assert.deepEqual(id, identity); assert.equal(payload._node_pending_ask_resume_id, 'synthetic-resume-receipt')
      assert.equal(signal.aborted, false); return 'cancelled'
    } })
    f.alterRoute({ ...groupRoute(), _node_pending_ask_resume_id: 'synthetic-resume-receipt' })
    f.selection.groupChat = true; f.selection.contextPolicy = { memoryEnabled: false, loadOwnerContext: false }
    if (!owned) f.loseCancellationOwnership()
    if (owned) assert.equal(await f.reconstruct(groupAttentionLease()), null)
    else { await assert.rejects(f.reconstruct(groupAttentionLease()), AgentDispatchDeferredError); assert.equal(f.counts().binds, 0) }
    assert.equal(verified, 1); assert.deepEqual(f.queries[0], [owner, identity.sessionId, identity.runId, 'synthetic-lease', 1])
  }
})

test('生产同一群回复门只接受已实际准备的零参数meta，参数错误/未准备/撤权不识为decline', async () => {
  const f = fixture(), input = { ownerId: owner, platform: 'telegram' as const, botId: '81', chatType: 'group' as const, chatId: 'synthetic-group',
    platformUserId: 'synthetic-owner', botMentioned: true, mentionsOtherBot: false }
  const gate = createImGroupReplyGate({ identity, input, authorizeTool: f.access.authorizeTool }), meta = createChooseNoReplyTool()
  const prepared = { toolNames: ['choose_no_reply'], tools: [gate.definition] }
  const context = (capabilities: CanonicalRunContext['capabilities'] = prepared) => ({ identity, capabilities } as CanonicalRunContext)
  const call = { id: 'synthetic-call', name: 'choose_no_reply', input: {} }
  assert.equal(meta.validate({}).success, true); assert.equal(await gate.classifyCall(context(), call), 'decline')
  for (const input of [null, undefined, [], '', { reason: '不应透传模型说明' }]) {
    assert.equal(meta.validate(input).success, false)
    assert.equal(await gate.classifyCall(context(), { ...call, input }), 'invalid')
  }
  for (const capabilities of [null, { toolNames: ['choose_no_reply'], tools: [] }, { toolNames: [], tools: [gate.definition] },
    { toolNames: ['choose_no_reply'], tools: [gate.definition, gate.definition] },
    { toolNames: ['choose_no_reply'], tools: [{ name: 'choose_no_reply', schema: { type: 'function', function: { name: 'another_tool' } } }] },
    { toolNames: ['choose_no_reply'], tools: [{ name: 'choose_no_reply', schema: { type: 'function', function: { name: 'choose_no_reply', parameters: { type: 'object' } } } }] },
  ]) assert.equal(await gate.classifyCall(context(capabilities), call), 'invalid')
  assert.equal(await gate.classifyCall(context(), { ...call, parseError: 'invalid_json' }), 'invalid')
  assert.equal(await gate.classifyCall({ ...context(), identity: { ...identity, runId: 'another-run' } }, call), 'invalid')
  const business = { name: 'get_current_time', schema: { type: 'function', function: { name: 'get_current_time', parameters: { type: 'object' } } } }
  assert.equal(await gate.classifyCall(context({ toolNames: [business.name], tools: [business] }), { ...call, name: business.name }), 'business')
  f.disable(); assert.equal(await gate.classifyCall(context(), call), 'invalid')
  assert.throws(() => createImGroupReplyGate({ identity, input: { ...input, chatType: 'c2c', chatId: null }, authorizeTool: f.access.authorizeTool }), /群回复门作用域无效/)
})

test('缺失加密路由返回不可用，跨 owner/Bot/平台/私聊身份路由拒绝重建', async () => {
  const absent = fixture(); absent.missingRoute()
  assert.equal(await absent.reconstruct(lease()), null)
  for (const patch of [{ owner_user_id: 'other' }, { bot_id: '82' }, { platform: 'qq' },
    { platform_user_id: 'synthetic-member' }, { chat_type: 'group' }]) {
    const f = fixture(); f.alterRoute(patch)
    await assert.rejects(f.reconstruct(lease()), AgentReconstructionVersionError)
    assert.equal(f.counts().binds, 0)
  }
})

test('Bot 当前停用或持久用户锚点消失，不绑定模型且不加载业务资源', async () => {
  for (const setup of [(f: ReturnType<typeof fixture>) => f.disable(), (f: ReturnType<typeof fixture>) => f.missingAnchor()]) {
    const f = fixture(); setup(f)
    await assert.rejects(f.reconstruct(lease()), /IM 权限不可用|消息锚点不存在/)
    assert.equal(f.counts().binds, 0)
  }
})

test('批次调度证明必须与密封路由的完整消息顺序一致，缺失或重排在绑定前拒绝', async () => {
  const batch = { batchKey: 'b'.repeat(64), segmentKey: 'c'.repeat(64), messageIds: [9, 7] }
  const message = { owner_user_id: owner, bot_id: '81', platform: 'telegram', platform_user_id: 'synthetic-owner', chat_type: 'c2c' }
  for (const patch of [{}, { _inbound_batch: { ...batch, messageIds: [7, 9] }, _batch_messages: [message, message] },
    { _inbound_batch: batch, _batch_messages: [message] },
    { _inbound_batch: batch, _batch_messages: [{ ...message, owner_user_id: 'other' }, message] }]) {
    const f = fixture(), candidate = lease()
    if (candidate.input.v !== 3) throw new Error('测试调度版本错误')
    candidate.input.im.batch = batch
    f.alterRoute(patch)
    await assert.rejects(f.reconstruct(candidate), AgentReconstructionVersionError)
    assert.equal(f.counts().binds, 0)
  }
  const valid = fixture(), candidate = lease()
  if (candidate.input.v !== 3) throw new Error('测试调度版本错误')
  candidate.input.im.batch = batch
  valid.alterRoute({ _inbound_batch: batch, _batch_messages: [message, message] })
  assert.equal(await valid.reconstruct(candidate), null)
  assert.equal(valid.counts().binds, 1)
  const undeclared = fixture()
  undeclared.alterRoute({ _inbound_batch: batch, _batch_messages: [message, message] })
  await assert.rejects(undeclared.reconstruct(lease()), AgentReconstructionVersionError)
  assert.equal(undeclared.counts().binds, 0)
})

test('访问版本、群私聊、locale、模型与上下文权限不一致时释放已绑定资源', async () => {
  const changes = [ { contextScopeKey: 'b'.repeat(64) }, { groupChat: true }, { locale: 'en-US' },
    { modelIdentity: '' }, { contextPolicy: { memoryEnabled: false, loadOwnerContext: false } } ]
  for (const change of changes) {
    const f = fixture(); Object.assign(f.selection, change)
    await assert.rejects(f.reconstruct(lease()), AgentReconstructionVersionError)
    assert.deepEqual(f.counts(), { releases: 1, binds: 1, resourcesCalls: 0 })
  }
})

test('恢复使用真实加密 checkpoint 模型版本；错误模式与模型不能回退为新运行', async () => {
  const mismatch = fixture(); mismatch.checkpoint('old-model')
  await assert.rejects(mismatch.reconstruct({ ...lease(), mode: 'resume' }), AgentReconstructionVersionError)
  assert.equal(mismatch.counts().releases, 1)
  const wrongMode = fixture(); wrongMode.checkpoint('synthetic-model')
  await assert.rejects(wrongMode.reconstruct(lease()), /恢复状态不匹配/)
  assert.equal(wrongMode.counts().binds, 0)
  const missing = fixture()
  await assert.rejects(missing.reconstruct({ ...lease(), mode: 'resume' }), /恢复状态不匹配/)
})

test('业务资源缺失或初始化失败各释放一次；未获 binding 不调用 release', async () => {
  const empty = fixture()
  assert.equal(await empty.reconstruct(lease()), null)
  assert.deepEqual(empty.counts(), { releases: 1, binds: 1, resourcesCalls: 1 })
  const failure = fixture(); failure.resources(async () => { throw new Error('合成初始化失败') })
  await assert.rejects(failure.reconstruct(lease()), /合成初始化失败/)
  assert.equal(failure.counts().releases, 1)
  const noBinding = fixture(); noBinding.noBinding()
  assert.equal(await noBinding.reconstruct(lease()), null)
  assert.equal(noBinding.counts().releases, 0)
})
