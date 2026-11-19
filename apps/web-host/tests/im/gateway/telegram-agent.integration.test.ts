import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createCanonicalSourceLoader, stableJson } from '../../../../../packages/core/src/agent/index.js'
import type { AgentRunnerPorts, CanonicalContextPorts, CanonicalMessage, CanonicalRunContext, Json, PersistedHistoryRow, RunCheckpoint, RunEvent, RunIdentity } from '../../../../../packages/core/src/agent/index.js'
import { createAgentRuntime } from '../../../../../packages/core/src/agent/runtime.js'
import { ProviderStreamSanitizer, stripThinking } from '../../../../../packages/core/src/agent/providers/index.js'
import { resolveImAccess, resolveImActor, imContextPolicy } from '../../../../../packages/core/src/im/access.js'
import { normalizeTelegramMessage } from '../../../../../packages/core/src/im/telegram-message.js'
import { createImRunDelivery } from '../../../../../packages/core/src/im/run-delivery.js'
import { createTelegramBotApi } from '../../../src/modules/im/gateway/telegram-api.js'
import { createTelegramSender } from '../../../src/modules/im/gateway/telegram-sender.js'
import { createImAgentContextBuilder } from '../../../src/modules/im/gateway/context-builder.js'
import { agentContextAccessScope } from '../../../src/modules/agent/model-config/access-scope.js'
import { bindProviderSelection } from '../../../src/modules/agent/model-config/provider-resolver.js'

const digest = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex')
const keyOf = (identity: RunIdentity): string => digest([identity.ownerId, identity.sessionId, identity.runId])
const memoryKey = (identity: Pick<RunIdentity, 'ownerId' | 'sessionId'>): string => `${identity.ownerId}:${identity.sessionId}`
const response = (value: string) => ({ status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode(value) })(), cancel: async () => {} })

/** 真实协议/规则/IM格式化/Harness集成；内存持久端口、租约、网络和通用业务资料为合成替身。
 * 不证明PG/Redis/平台网络或生产Gateway入口接线完成。 */
test('Telegram解析经可信身份、实际上下文加载与Agent Provider再回平台，恢复不重跑或重复回复', async () => {
  const histories = new Map<string, PersistedHistoryRow[]>()
  const memories = new Map<string, { scope: string; text: string }>()
  const checkpoints = new Map<string, RunCheckpoint<CanonicalRunContext>>()
  const outbox = new Map<string, RunEvent[]>()
  const deliveryCursors = new Map<string, number>()
  const receipts = new Map<string, { fingerprint: string; state: 'pending' | 'accepted' | 'unknown' }>()
  const providerRequests: { identity: RunIdentity; body: unknown }[] = []
  const apiRequests: Record<string, unknown>[] = []
  const completedHistory: { identity: RunIdentity; text: string }[] = []
  const ownerReads: string[] = []
  const bot = { id: '41', ownerId: 'owner-synthetic', platform: 'telegram' as const,
    ownerPlatformUserId: '7001', groupAllowedTools: ['read_file'], groupOwnerMemoryEnabled: false }
  const cases = [
    { name: 'group-a', chatId: '-1007002', chatType: 'supergroup', actorId: 7002, role: 'member' },
    { name: 'group-b', chatId: '-1007003', chatType: 'group', actorId: 7003, role: 'member' },
    { name: 'owner-private', chatId: '7001', chatType: 'private', actorId: 7001, role: 'owner' },
  ]
  for (const item of cases) {
    const identity = { ownerId: bot.ownerId, sessionId: item.name, runId: `run-${item.name}` }
    const persisted = [
      { ...identity, id: `${item.name}-1`, conversationSeq: 1, role: 'user', content: `${item.name}历史问题` },
      { ...identity, id: `${item.name}-2`, conversationSeq: 2, role: 'assistant', content: `${item.name}历史回答` },
      { ...identity, id: `${item.name}-3`, conversationSeq: 3, role: 'user', content: `${item.name}当前问题` },
    ]
    histories.set(memoryKey(identity), persisted)
    memories.set(memoryKey(identity), { scope: `telegram:${bot.id}:${item.chatId}`, text: `${item.name}范围记忆` })
  }
  for (const item of cases) {
    const parsed = normalizeTelegramMessage({ update_id: 91, message: {
      message_id: 31, date: 1_791_000_000, chat: { id: Number(item.chatId), type: item.chatType },
      from: { id: item.actorId, first_name: '小北' }, text: `${item.name}当前问题`,
    } }, { botId: bot.id, ownerId: bot.ownerId, botUsername: 'gugu_bot', botPlatformId: '9001' })
    assert.ok(parsed)
    const actor = resolveImActor({ ownerId: bot.ownerId, botId: bot.id, platform: 'telegram',
      platformUserId: parsed.platform_user_id, chatType: parsed.chat_type, chatId: parsed.chat_id,
      botMentioned: parsed.bot_mentioned, mentionsOtherBot: parsed.mentions_other_bot === true }, scope => resolveImAccess(scope, bot))
    assert.equal(actor.role, item.role)
    const identity: RunIdentity = { ownerId: bot.ownerId, sessionId: item.name, runId: `run-${item.name}` }
    const policy = { groupChat: actor.chatType === 'group', contextPolicy: imContextPolicy(actor, bot, true) }
    const scope = agentContextAccessScope('synthetic-access-signing-key', identity, policy,
      { permissions: '1', model: '1', credentials: '1' }, digest, `telegram:${bot.id}:${parsed.chat_id}:${actor.role}`)
    const bound = await bindProviderSelection(identity, {
      selectPlatformModel: async () => ({ config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '合成IM系统', byokEnabled: false, localDeployment: false, accessScopeHash: scope.accessScopeHash }),
      readActiveCredential: async () => null, decryptCredential: () => { throw new Error('不应读取凭据') }, defaultBaseUrl: () => '',
    }, new AbortController().signal)
    const owned = (requested: Pick<RunIdentity, 'ownerId' | 'sessionId'>) => {
      assert.equal(requested.ownerId, identity.ownerId)
      assert.equal(requested.sessionId, identity.sessionId)
      const rows = histories.get(memoryKey(requested))
      assert.ok(rows, '必须找到已归属的持久消息，不能替换为空历史')
      return rows
    }
    const readOwner = async (name: string, value: Json): Promise<Json> => {
      assert.equal(actor.role, 'owner', '群成员不得调用owner上下文端口')
      ownerReads.push(`${item.name}:${name}`)
      return value
    }
    let requestPrefix: CanonicalMessage[] = []
    const imBuilder = createImAgentContextBuilder(actor, {
      staticPrompt: () => ({ base: '合成IM系统', persona: '', skills: '', policy: '', retrieval: '', skillIndex: '', timezone: 'UTC', now: new Date('2026-11-17T00:00:00Z') }),
      sessionInfo: () => ({ source: 'web' }), systemInMessages: () => false,
      now: () => Date.parse('2026-11-17T00:00:00Z'),
    })
    const source = createCanonicalSourceLoader({ digest, nextId: randomUUID, now: () => 0,
      readSnapshot: async requested => { owned(requested); return { ownerId: requested.ownerId, sessionId: requested.sessionId, contextEpoch: 0, context: null, snapshotHash: null, sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 } },
      select: async requested => { owned(requested); return { ...policy, modelIdentity: bound.modelIdentity, contextWindow: 10000, locale: 'zh-CN', workspaceBinding: null, contextScopeKey: scope.contextScopeKey } },
      currentRevision: async () => 0,
      historyReader: { read: async requested => ({ baselineSeq: 0, rows: structuredClone(owned(requested)) }) },
      currentTurn: async requested => {
        const anchor = owned(requested).find(row => row.id === `${item.name}-3`)
        assert.ok(anchor)
        assert.equal(anchor.content, parsed.text)
        return { currentUser: { persistedMessageId: anchor.id, rawText: parsed.text, message: { role: 'user', content: parsed.text } } }
      },
      data: {
        loadTimezone: async () => 'UTC',
        loadProjects: async () => readOwner('projects', [{ id: 7, name: '合成owner项目', status: 'active', deadline: null, contact: null, summary: '', stagesDone: 0, stagesTotal: 0, roots: [], totalFiles: 0, rootFiles: 0, totalFolders: 0 }]),
        loadEvents: async () => readOwner('events', [{ date: '2026-11-18', title: '合成owner事件' }]),
        loadNotes: async () => readOwner('notes', [{ title: '合成owner笔记', content: '合成owner笔记正文', capturedAt: '2026-11-16T00:00:00Z' }]),
        loadFilesOverview: async () => readOwner('files', { total: 1, trash: 0, folders: [], files: [{ name: '合成owner文件', folder: null }] }),
        loadStylePreferences: async () => readOwner('style', { text: '合成owner风格' }), loadImChannels: async () => readOwner('channels', { telegram: true }),
        loadMemory: async () => readOwner('memory', { memory: 'owner-private-memory' }), loadKnowledge: async () => readOwner('knowledge', [{ title: '合成owner知识', description: '合成知识摘要' }]),
        loadImMemory: async (requested): Promise<Json> => {
          owned(requested)
          const memory = memories.get(memoryKey(requested))
          assert.ok(memory)
          assert.equal(memory.scope, `telegram:${bot.id}:${parsed.chat_id}`)
          return actor.chatType === 'group' ? { group: { summary: memory.text } } : { platform_user: { summary: memory.text } }
        },
      },
      builder: {
        buildSnapshot: imBuilder.buildSnapshot,
        buildRequest: (snapshot, selection, requested) => {
          const request = imBuilder.buildRequest(snapshot, selection, requested)
          requestPrefix = structuredClone(request.fixedPrefix)
          return request
        },
      },
    })
    const context: CanonicalContextPorts = {
      digest, nextId: randomUUID, load: async (requested, signal) => ({ ...await source.load(requested, signal), capabilities: { toolNames: [], tools: [] } }),
      preparation: { buildRag: async () => ({ tail: [] }) }, prepareRequest: async () => {
        assert.ok(requestPrefix.length, '请求前缀必须来源于已装配的IM快照')
        return { prefix: structuredClone(requestPrefix), dynamicTail: [] }
      },
      references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
      compaction: { summarize: async () => { throw new Error('意外压缩') } }, finalization: { complete: async () => {} }, currentRequest: () => null,
      stageContinuation: async () => { throw new Error('意外续接') }, releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
    }
    type RuntimePorts = Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>
    const runtime: RuntimePorts = {
      clock: { now: () => '2026-01-01T00:00:00Z' },
      store: {
        read: async requested => checkpoints.get(keyOf(requested)) ?? null,
        create: async (value, _lease, events) => { assert.equal(checkpoints.has(keyOf(value.identity)), false); checkpoints.set(keyOf(value.identity), structuredClone(value)); outbox.set(keyOf(value.identity), structuredClone([...events])) },
        commit: async change => { const key = keyOf(change.checkpoint.identity); assert.equal(checkpoints.get(key)?.version, change.expectedVersion); checkpoints.set(key, structuredClone(change.checkpoint)); outbox.get(key)!.push(...structuredClone([...change.events])); if (change.history) completedHistory.push({ identity, text: change.history.text }) },
        pendingEvents: async requested => outbox.get(keyOf(requested)) ?? [], acknowledgeEvents: async () => {},
      },
      leases: { acquire: async () => ({ token: 'synthetic-lease', fence: 1 }), assert: async () => {}, release: async () => {} },
      cancellation: { isRequested: async () => false, request: async () => {}, notify: async () => {}, subscribe: async () => () => {} },
      tools: { dispatch: async () => { throw new Error('不应调用工具') }, reconcile: async () => ({ kind: 'unknown' }) },
      interactions: { activate: async (_requested, request) => request }, sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
      presentError: () => ({ code: 'failed', text: '模型不可用' }), presentToolResult: async value => value, publish: async () => {}, diagnose: () => {},
    }
    const instance = createAgentRuntime({ context, runtime,
      executor: { authorize: async () => { throw new Error('不应授权进程') }, executor: { execute: async () => { throw new Error('不应执行进程') } } },
      provider: { resolve: bound.resolve, transport: { request: async request => {
        providerRequests.push({ identity, body: request.body })
        return response(`data: ${JSON.stringify({ choices: [{ delta: { content: `${item.name}合成回复` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      } } },
    })
    const api = createTelegramBotApi({ transport: { request: async request => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org')
      assert.equal(new URL(request.url).pathname.endsWith('/sendMessage'), true)
      assert.ok(request.body instanceof Uint8Array)
      apiRequests.push(JSON.parse(new TextDecoder().decode(request.body)))
      return response(JSON.stringify({ ok: true, result: { message_id: apiRequests.length + 100 } }))
    } } })
    const sender = createTelegramSender({ token: '12345:synthetic_telegram_token_value', api })
    const delivery = createImRunDelivery({ runner: instance.harness, digest,
      events: { readAfter: async (requested, sequence) => (outbox.get(keyOf(requested)) ?? []).filter(event => event.sequence > sequence) },
      receipts: {
        cursor: async requested => deliveryCursors.get(keyOf(requested)) ?? 0,
        begin: async (requested, id, fingerprint) => {
          const key = `${keyOf(requested)}:${id}`, existing = receipts.get(key)
          if (existing) { assert.equal(existing.fingerprint, fingerprint); return existing.state }
          receipts.set(key, { fingerprint, state: 'pending' }); return 'new'
        },
        settle: async (requested, id, result) => { const receipt = receipts.get(`${keyOf(requested)}:${id}`); assert.ok(receipt); assert.equal(result, 'accepted'); receipt.state = result },
        advance: async (requested, expected, next) => { const key = keyOf(requested); assert.equal(deliveryCursors.get(key) ?? 0, expected); deliveryCursors.set(key, next) },
      },
      authorize: async requested => requested.ownerId === bot.ownerId && requested.sessionId === identity.sessionId && resolveImAccess(actor, bot).role === actor.role,
      sender: {
        text: async ({ identity: requested, text }) => { assert.deepEqual(requested, identity); return (await sender.text({ chatId: parsed.chat_id, chatType: parsed.chat_type, replyToMessageId: parsed.message_id }, text)).outcome },
        artifact: async () => { throw new Error('未请求附件') }, interaction: async () => { throw new Error('未请求交互') },
      },
    })
    try {
      await delivery.start(identity)
      assert.equal(checkpoints.get(keyOf(identity))?.status, 'completed')
      assert.equal(providerRequests.length, cases.indexOf(item) + 1)
      assert.equal(apiRequests.length, cases.indexOf(item) + 1, 'round_end与final只能回复一次')
      assert.deepEqual(apiRequests.at(-1), { chat_id: parsed.chat_id, text: `${item.name.replaceAll('-', '\\-')}合成回复`, parse_mode: 'MarkdownV2', reply_to_message_id: 31 })
      const wire = JSON.stringify(providerRequests.at(-1)!.body)
      if (actor.chatType === 'group') assert.ok(wire.includes(`${item.name}范围记忆`), '群公开IM记忆必须经生产formatter进入真实Provider请求')
      else assert.equal(wire.includes(`${item.name}范围记忆`), false, 'owner私聊使用owner域，不能复用受限成员scope资料')
      assert.ok(wire.includes('Telegram'), '实际IM来源投影必须进入Provider请求')
      assert.ok(wire.includes(`${item.name}历史问题`))
      assert.ok(wire.includes(`${item.name}历史回答`))
      assert.equal(wire.split(`${item.name}当前问题`).length - 1, 1, '持久锚点不得导致当前输入重复')
      for (const other of cases.filter(candidate => candidate !== item)) assert.equal(wire.includes(`${other.name}范围记忆`), false)
      assert.equal(wire.includes('owner-private-memory'), actor.role === 'owner')
      for (const marker of ['合成owner项目', '合成owner事件', '合成owner笔记', '合成owner文件', '合成owner知识'])
        assert.equal(wire.includes(marker), actor.role === 'owner', '正式公共formatter必须保留已授权业务资料并裁剪成员owner域')
      await delivery.recover(identity)
      await delivery.recover(identity)
      assert.equal(providerRequests.length, cases.indexOf(item) + 1)
      assert.equal(apiRequests.length, cases.indexOf(item) + 1)
      // 伪造owner无法使用已有outbox或游标取得任何平台副作用。
      const forged = { ...identity, ownerId: 'other-owner' }
      outbox.set(keyOf(forged), structuredClone(outbox.get(keyOf(identity))!))
      await assert.rejects(() => delivery.recover(forged), /IM 事件运行身份不匹配/)
      assert.equal(apiRequests.length, cases.indexOf(item) + 1)
    } finally { await instance.close(); bound.release(); await api.close() }
  }
  assert.equal(ownerReads.length, 8)
  assert.ok(ownerReads.every(name => name.startsWith('owner-private:')))
  assert.deepEqual(completedHistory.map(row => row.text), cases.map(item => `${item.name}合成回复`))
})
