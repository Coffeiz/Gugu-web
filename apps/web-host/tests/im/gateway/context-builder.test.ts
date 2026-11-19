import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSessionSnapshot, type ContextData, type ContextSourceSelection, type SnapshotPayload } from '@gugu/core/agent'
import { resolveImActor } from '@gugu/core/im/access'
import { createImAgentContextBuilder } from '../../../src/modules/im/gateway/context-builder.js'

const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
/** buildRequest消费持久快照投影，不能把尚未写入的SnapshotPayload冒充完整请求契约。 */
function persisted(snapshot: SnapshotPayload) {
  return readSessionSnapshot({ ownerId: identity.ownerId, sessionId: identity.sessionId, contextEpoch: 1, baselineMessageSeq: 0,
    snapshotHash: 'synthetic-snapshot', sessionInfoHash: null, snapshotExpiresAt: null,
    context: { system_prompt: snapshot.systemPrompt, snapshot_context: snapshot.snapshotContext, session_info: snapshot.sessionInfo,
      user_tz: snapshot.userTimezone, im_channels: snapshot.imChannels ?? {}, im_memory: snapshot.imMemory ?? {} } })
}
function fixture(group = true, role: 'member' | 'owner' = 'member') {
  const actor = resolveImActor({ ownerId: identity.ownerId, botId: '7', platform: 'telegram', chatType: group ? 'group' : 'c2c',
    chatId: group ? '-9' : null, platformUserId: 'sender-a', botMentioned: true, mentionsOtherBot: false },
  () => ({ role, allowedToolNames: role === 'owner' ? null : [] }))
  const selection: ContextSourceSelection = { modelIdentity: 'model-a', contextWindow: 10_000, locale: 'zh-CN', groupChat: group,
    workspaceBinding: null, contextScopeKey: 'scope-a', contextPolicy: { loadOwnerContext: role === 'owner', memoryEnabled: true } }
  const data: ContextData = { userTimezone: 'UTC', projects: ['owner-project'], events: ['owner-calendar'], notes: ['owner-note'],
    filesOverview: { marker: 'owner-file' }, stylePreferences: { marker: 'owner-style' }, memory: { marker: 'owner-memory' },
    imChannels: { feishu: true }, knowledge: ['owner-knowledge'], imMemory: {
      group: { summary: '群公开摘要', profile: '群公开资料', memory: 'group-private-memory' },
      platform_user: { summary: '成员个人摘要', pattern: '成员个人偏好' },
    } }
  const builder = createImAgentContextBuilder(actor, {
    staticPrompt: (_selection, _identity, preferences) => ({ base: '合成基础', persona: JSON.stringify(preferences), skills: '', policy: '', retrieval: '', skillIndex: '', timezone: 'UTC', now: new Date('2026-11-17T00:00:00Z') }),
    sessionInfo: () => ({ source: 'web' }), systemInMessages: () => true,
    dynamic: source => ({ memoryBlock: JSON.stringify(source), projectBlock: '', sourceBlock: 'web-source', events: [], notes: [], files: null, knowledge: [],
      includeProjects: false, includeCalendar: false, includeFiles: false, includeKnowledge: false }),
  })
  return { actor, selection, data, builder }
}

test('IM生产formatter投影群公开记忆和真实平台来源，不把owner或成员私有数据放进群快照', () => {
  const f = fixture()
  const snapshot = f.builder.buildSnapshot(f.data, f.selection, identity)
  assert.match(snapshot.snapshotContext, /群公开摘要/)
  assert.match(snapshot.snapshotContext, /Telegram/)
  assert.doesNotMatch(snapshot.snapshotContext, /owner-|成员个人|group-private-memory|web-source/)
  assert.equal(snapshot.sessionInfo.source, 'telegram')
  assert.deepEqual(snapshot.imMemory, { group: { summary: '群公开摘要', profile: '群公开资料' } })
  assert.equal((f.data.imMemory as Record<string, unknown>).platform_user !== undefined, true)
  const request = f.builder.buildRequest(persisted(snapshot), f.selection, identity)
  assert.match(JSON.stringify(request.fixedPrefix), /群公开摘要/)
  assert.doesNotMatch(request.systemPrompt, /owner-style/)
})

test('受限私聊仅快照当前成员资料，owner记忆开关关闭仍保留已授权IM scope', () => {
  const member = fixture(false)
  const snapshot = member.builder.buildSnapshot(member.data, member.selection, identity)
  assert.match(snapshot.snapshotContext, /成员个人摘要/)
  assert.doesNotMatch(snapshot.snapshotContext, /群公开|owner-/)
  const owner = fixture(false, 'owner')
  const hidden = owner.builder.buildSnapshot(owner.data, { ...owner.selection, contextPolicy: { ...owner.selection.contextPolicy, memoryEnabled: false } }, identity)
  assert.doesNotMatch(hidden.snapshotContext, /owner-memory/)
  assert.match(hidden.snapshotContext, /owner-project/)
})

test('不同owner、群类型、角色或成员的快照不能跨作用域复用', () => {
  const f = fixture()
  const snapshot = f.builder.buildSnapshot(f.data, f.selection, identity)
  assert.throws(() => f.builder.buildSnapshot(f.data, f.selection, { ...identity, ownerId: 'owner-b' }), /不匹配/)
  assert.throws(() => f.builder.buildSnapshot(f.data, { ...f.selection, groupChat: false }, identity), /不匹配/)
  assert.throws(() => f.builder.buildSnapshot(f.data, { ...f.selection, contextPolicy: { ...f.selection.contextPolicy, loadOwnerContext: true } }, identity), /不匹配/)
  const owner = fixture(true, 'owner')
  assert.throws(() => owner.builder.buildRequest(persisted(snapshot), owner.selection, identity), /作用域不匹配/)
  const other = createImAgentContextBuilder({ ...f.actor, platformUserId: 'sender-b' }, {
    staticPrompt: () => { throw new Error('不应格式化') }, dynamic: () => { throw new Error('不应格式化') },
    sessionInfo: () => ({}), systemInMessages: () => true,
  })
  assert.throws(() => other.buildRequest(persisted(snapshot), f.selection, identity), /作用域不匹配/)
})

test('IM默认复用正式公共业务formatter，无dynamic替身也保留群scope和裁剪owner资料', () => {
  const f = fixture()
  const ports = {
    now: () => Date.parse('2026-11-17T00:00:00Z'),
    staticPrompt: () => ({ base: '合成基础', persona: '', skills: '', policy: '', retrieval: '', skillIndex: '', timezone: 'UTC', now: new Date('2026-11-17T00:00:00Z') }),
    sessionInfo: () => ({}), systemInMessages: () => true,
  }
  const builder = createImAgentContextBuilder(f.actor, ports)
  const snapshot = builder.buildSnapshot(f.data, f.selection, identity)
  assert.match(snapshot.snapshotContext, /群公开摘要/)
  assert.match(snapshot.snapshotContext, /Telegram/)
  assert.doesNotMatch(snapshot.snapshotContext, /owner-|成员个人|group-private-memory/)
  const request = builder.buildRequest(persisted(snapshot), f.selection, identity)
  assert.match(JSON.stringify(request.fixedPrefix), /群公开摘要/)
  const owner = fixture(false, 'owner')
  const ownerData: ContextData = { ...owner.data, projects: [], events: [{ date: '2026-11-18', title: '授权日历' }], notes: [],
    filesOverview: { total: 1, trash: 0, folders: [], files: [{ name: '授权文件.md', folder: null }] },
    memory: { memory: 'owner-memory' }, knowledge: [{ title: '授权知识' }] }
  const ownerBuilder = createImAgentContextBuilder(owner.actor, ports)
  const visible = ownerBuilder.buildSnapshot(ownerData, owner.selection, identity)
  for (const text of ['授权日历', '授权文件.md', '授权知识', 'owner-memory']) assert.match(visible.snapshotContext, new RegExp(text))
  const disabled = ownerBuilder.buildSnapshot(ownerData, { ...owner.selection, contextPolicy: { ...owner.selection.contextPolicy, memoryEnabled: false } }, identity)
  assert.doesNotMatch(disabled.snapshotContext, /owner-memory/)
  assert.match(disabled.snapshotContext, /授权日历/)
  assert.throws(() => createImAgentContextBuilder(f.actor, { ...ports, now: undefined }), /时钟未配置/)
})
