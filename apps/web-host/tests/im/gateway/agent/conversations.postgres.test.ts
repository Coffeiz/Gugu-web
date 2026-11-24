import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { createPostgresImConversationStore, ImConversationError } from '../../../../src/modules/im/gateway/agent/conversations.js';
import type { ImConversationAnchor, ImConversationAttachments } from '../../../../src/modules/im/gateway/agent/conversations.js';
import { createPostgresImIngress } from '../../../../src/modules/im/gateway/inbound/ingress.js';
import { createImInboundEnvelope } from '../../../../src/modules/im/gateway/inbound/envelope.js';
import type { ImAttentionRecord } from '@gugu/core/im/attention/directive';
import { createRedisStreamCommands } from '../../../../src/adapters/cache/redis-stream-commands.js';
import { createPostgresImAttentionRuntime } from '../../../../src/modules/im/gateway/attention/runtime.js';
import { createPostgresRedisImAttentionSnapshot } from '../../../../src/modules/im/gateway/attention/snapshot.js';
import { createPostgresImAcceptedFactsReader } from '../../../../src/modules/im/gateway/attention/ledger.js';
import { createRedisImPendingAskStore } from '../../../../src/modules/im/gateway/interactions/ask.js';
import { nodeImAttentionKeys } from '../../../../src/modules/im/gateway/inbound/inbox.js';
import { decryptAgentDispatchInput } from '../../../../src/modules/agent/run/dispatch.js';

const owner = '00000000-0000-4000-8000-000000000071';
const binding = { ownerId: owner, platform: 'telegram' as const, botId: '71' };
const payload = { platform: 'telegram', owner_user_id: owner, channel_id: '71', chat_type: 'c2c', platform_user_id: 'synthetic-user', message_id: 'platform-1', platform_message_id: 'platform-1', text: '合成消息', context_token: 'synthetic-reply-secret' };
const secretKey = 'synthetic-receipt-encryption';
type Row = Record<string, unknown>;
/** 查询/事务契约替身；真实行锁、PG回滚与并发只由下方opt-in测试验收。 */
function fixture() {
  let db = { sessions: [] as Row[], messages: [] as Row[], receipts: [] as Row[], startups: [] as Row[], dispatches: [] as Row[], segments: [] as Row[], members: [] as Row[] };
  let allowed = true, classify: 'reply' | 'passive' | 'control' = 'reply', dispatches = 0, claimCount = 0, notified = 0, failDispatch = false;
  let attachments: ImConversationAttachments = { mode: 'text-only' };
  let botPlatform = 'telegram';
  const groupPolicy = { group_chat_enabled: true, feishu_group_chat_enabled: true as boolean | null, group_requires_at: false, group_read_enabled: false };
  const statements: string[] = [];
  const pool = { async connect() {
    let local = db;
    return { async query(sql: string, values: unknown[] = []) {
      statements.push(sql);
      const rows = (data: Row[]) => ({ rows: data, rowCount: data.length });
      if (sql === 'BEGIN') { local = structuredClone(db); return rows([]); }
      if (sql === 'COMMIT') { db = local; return rows([]); }
      if (sql === 'ROLLBACK') return rows([]);
      if (sql.includes('pg_advisory_xact_lock')) return rows([]);
      if (sql.startsWith('SELECT group_chat_enabled,feishu_group_chat_enabled')) return rows([{ ...groupPolicy }]);
      if (sql.startsWith('SELECT 1 FROM gugu_im_inbound_receipts WHERE')) return rows(local.receipts.filter(row => row.user_id === values[0] && row.session_id === values[1] && row.run_id === values[2]
        && (Array.isArray(values[3]) ? !(values[3] as number[]).includes(Number(row.message_id)) : row.message_id !== values[3])));
      if (sql.startsWith('SELECT message_id,sealed_payload FROM gugu_im_inbound_receipts')) return rows(local.receipts.filter(row => row.user_id === values[0]
        && row.session_id === values[1] && (values[2] as number[]).includes(Number(row.message_id))));
      if (sql.startsWith('SELECT 1 FROM gugu_im_inbound_segments WHERE')) return rows(local.segments.filter(row => row.prefix === JSON.stringify(values.slice(0, 5))
        && row.state === 'started' && Number(row.sequence) < Number(values[5])));
      if (sql.startsWith('SELECT b.*,bm.event_hash')) {
        const members = local.members.filter(row => row.prefix === JSON.stringify(values.slice(0, 5)) && (values[5] as string[]).includes(String(row.event_hash)));
        return rows(members.map(member => ({ ...local.segments.find(row => row.segment_key === member.segment_key)!, event_hash: member.event_hash })));
      }
      if (sql.startsWith('SELECT b.* FROM gugu_im_inbound_segments')) return rows(local.segments.filter(row => sql.includes('JOIN user_bots')
        ? row.user_id === values[0] && row.session_id === values[1] && row.run_id === values[2] && row.state === 'completed'
        : row.prefix === JSON.stringify(values.slice(0, 5)) && row.segment_key === values[5]));
      if (sql.startsWith('SELECT m.id,m.conversation_seq::text,m.run_id,r.fingerprint')) return rows(local.messages.filter(row => row.session_id === values[1] && (values[2] as number[]).includes(Number(row.id)))
        .map(row => ({ ...row, fingerprint: local.receipts.find(receipt => receipt.message_id === row.id)!.fingerprint })));
      if (sql.startsWith('INSERT INTO gugu_im_inbound_segments')) {
        local.segments.push({ sequence: local.segments.length + 1, prefix: JSON.stringify(values.slice(0, 5)), user_id: values[0], platform: values[1], bot_id: values[2], chat_type: values[3], scope_hash: values[4],
          segment_key: values[5], batch_key: values[6], segment_index: values[7], session_id: values[8], state: 'started', mode: values[9], run_id: null,
          anchors: JSON.parse(String(values[10])), sealed_payload: JSON.parse(String(values[11])) }); return rows([{}]);
      }
      if (sql.startsWith('INSERT INTO gugu_im_inbound_batch_members')) {
        local.members.push({ prefix: JSON.stringify(values.slice(0, 5)), event_hash: values[5], segment_key: values[6], ordinal: values[7] }); return rows([{}]);
      }
      if (sql.startsWith('UPDATE conversation_messages m SET run_id=$4')) {
        const messages = local.messages.filter(row => row.session_id === values[1] && (values[2] as number[]).includes(Number(row.id)));
        for (const message of messages) message.run_id = values[3]; return rows(messages);
      }
      if (sql.startsWith('UPDATE gugu_im_inbound_receipts r SET state=$7')) {
        const members = local.members.filter(row => row.prefix === JSON.stringify(values.slice(0, 5)) && row.segment_key === values[5]);
        const receipts = local.receipts.filter(row => members.some(member => member.event_hash === JSON.parse(String(row.key))[5]));
        for (const row of receipts) { row.state = values[6]; row.run_id = values[7]; } return rows(receipts);
      }
      if (sql.startsWith("UPDATE gugu_im_inbound_segments SET state='completed'")) {
        const row = local.segments.find(row => row.prefix === JSON.stringify(values.slice(0, 5)) && row.segment_key === values[5])!;
        row.state = 'completed'; row.run_id = values[6]; return rows([row]);
      }
      if (sql.includes('FROM user_bots b JOIN users')) return values[1] === owner && values[2] === botPlatform && allowed ? rows([{ id: '71', owner_id: owner, platform: botPlatform, enabled: true,
        owner_platform_user_id: 'synthetic-user', group_allowed_tools: [], group_owner_memory_enabled: false, ...groupPolicy, is_active: true, account_status: 'active' }]) : rows([]);
      if (sql.startsWith('INSERT INTO agent_run_startups')) { local.startups.push({ owner: values[0], session: values[1], run: values[2] }); return rows([{}]); }
      if (sql.startsWith('SELECT 1 FROM conversation_messages')) return rows(local.messages.filter(row => row.session_id === Number(values[1]) && row.id === values[2]));
      if (sql.startsWith('INSERT INTO agent_run_dispatch')) { local.dispatches.push({ user: values[0], session: values[1], run: values[2], nonce: values[3], payload: values[4] }); return rows([{}]); }
      if (sql.startsWith('UPDATE conversation_sessions SET pending_message_count')) return rows([]);
      if (sql.includes('FROM gugu_im_inbound_receipts r')) {
        const candidates = sql.includes('JOIN user_bots') ? local.receipts.filter(row => row.user_id === values[0] && row.session_id === values[1] && row.run_id === values[2] && row.state === 'dispatched')
          : local.receipts.filter(row => row.key === JSON.stringify(values));
        return rows(candidates.map(row => ({ ...row, batched: local.members.some(member => member.event_hash === JSON.parse(String(row.key))[5]), conversation_seq: String(local.messages.find(message => message.id === row.message_id)!.conversation_seq) })));
      }
      if (sql.startsWith('SELECT id FROM conversation_sessions')) {
        if (sql.includes('FOR NO KEY UPDATE')) return rows(local.sessions.filter(row=>row.user_id===values[0]&&row.id===values[1]));
        if (sql.includes("source='web'")) return rows(local.sessions.filter(row => row.id === values[0] && row.user_id === values[1] && (row.source === 'web' || row.source == null)));
        const [user, platform, bot, chat, sender, explicit] = values;
        return rows(local.sessions.filter(row => row.user_id === user && row.source === platform && row.bot_id === bot && (chat != null ? row.chat_id === chat : row.chat_id === null && row.platform_user_id === sender) && (explicit === undefined || row.id === explicit)).slice(-1));
      }
      if (sql.startsWith('INSERT INTO conversation_sessions')) {
        const row = { id: local.sessions.length + 1, user_id: values[0], source: values[2], bot_id: values[3], chat_id: values[4], platform_user_id: values[5], chat_type: values[6], last_message_seq: 0 };
        local.sessions.push(row); return rows([row]);
      }
      if (sql.startsWith('UPDATE conversation_sessions SET last_message_seq')) {
          const row = local.sessions.find(row => row.id === values[0] && row.user_id === values[1]); if (!row) return rows([]);
          row.chat_type = values[2] ?? row.chat_type;
        row.last_message_seq = Number(row.last_message_seq) + 1; return rows([row]);
      }
      if (sql.startsWith('INSERT INTO conversation_messages')) {
        const row = { id: local.messages.length + 1, session_id: values[0], conversation_seq: values[1], content: values[2], client_message_id: values[3], files: values[4], run_id: values[17] };
        local.messages.push(row); return rows([row]);
      }
      if (sql.startsWith('INSERT INTO gugu_im_inbound_receipts')) {
        local.receipts.push({ key: JSON.stringify(values.slice(0, 6)), user_id: values[0], platform: values[1], bot_id: values[2], fingerprint: values[6], session_id: values[7], message_id: values[8], state: 'staged', run_id: null, sealed_payload: JSON.parse(String(values[9])) }); return rows([]);
      }
      if (sql.startsWith('UPDATE conversation_messages SET run_id')) { local.messages.find(row => row.id === values[0] && row.session_id === values[1])!.run_id = values[2]; return rows([]); }
      if (sql.startsWith('UPDATE gugu_im_inbound_receipts SET state')) { const row = local.receipts.find(row => row.key === JSON.stringify(values.slice(0, 6)))!; row.state = sql.includes("state='passive'") ? 'passive' : 'dispatched'; row.run_id = values[6] ?? null; return rows([]); }
      throw new Error('未识别的查询');
    }, release() {} } as unknown as PoolClient;
  }, async query(sql: string, values: unknown[]) { const client = await this.connect(); return client.query(sql, values); } } as Pick<Pool, 'connect' | 'query'>;
  const make = () => createPostgresImConversationStore({ pool, secretKey, attachments,
    authorize: async () => allowed, classify: async () => classify, afterCommit: async () => { notified++; },
  });
  const dispatch = async (_client: PoolClient, anchor: ImConversationAnchor) => { dispatches++; if (failDispatch) throw new Error('synthetic-reply-secret'); return `run-${anchor.messageId}`; };
  return { make, dispatch, pool, statements, db: () => db, counts: () => ({ dispatches, claimCount, notified }),
    platform(value: string) { botPlatform = value; }, groupPolicy(value: Partial<typeof groupPolicy>) { Object.assign(groupPolicy, value); },
    allow(value: boolean) { allowed = value; }, classification(value: typeof classify) { classify = value; }, failDispatch() { failDispatch = true; },
    attachments() { attachments = { mode: 'enabled', async resolve(_client, _owner, ids) { return ids.map(attach_id => ({ attach_id, name: '合成附件', kind: 'file', upload: true })); }, async claim() { claimCount++; } }; },
  };
}
test('首次dispatch原子创建会话/锚点/密封收据，同事件重投不新增历史或重复派发', async () => {
  const f = fixture(), store = f.make();
  const first = await store.persist(binding, payload, { eventId: '100-0', mode: 'dispatch', onDispatch: f.dispatch });
  assert.deepEqual(first, { sessionId: 1, messageId: 1, conversationSeq: 1, runId: 'run-1', duplicate: false, isNewSession: true });
  const retry = await store.persist(binding, { ...payload, trace_id: 'changed-diagnostic-only' }, { eventId: '200-0', mode: 'dispatch', onDispatch: f.dispatch });
  assert.equal(retry!.duplicate, true); assert.equal(f.db().messages.length, 1); assert.equal(f.counts().dispatches, 1);
  assert.ok(!JSON.stringify(f.db().receipts).includes('synthetic-reply-secret'));
  const route = await store.readRoute({ ownerId: owner, sessionId: '1', runId: 'run-1' }); assert.equal(route.payload.context_token, payload.context_token);
  await assert.rejects(store.persist(binding, { ...payload, text: '改写同一事件' }, { eventId: '300-0', mode: 'dispatch', onDispatch: f.dispatch }), error => error instanceof ImConversationError && error.code === 'conflict');
});

test('正式Ingress把可信身份与消息事务接到真实startup/加密v3调度，重投不新建Run；绑定失败全部回滚', async () => {
  const f = fixture(); let failVersion = false, notices = 0, control = false;
  const ingress = createPostgresImIngress({ pool: f.pool, secretKey, attachments: { mode: 'text-only' },
    supportedPlatforms: () => ['telegram'], async preflight(input) { assert.equal(input.scope.ownerId, owner); return control ? 'consumed' : 'enqueue'; },
    model: { async accessVersion(identity, actor) { assert.equal(identity.ownerId, actor.ownerId); if (failVersion) throw new Error('合成模型绑定故障'); return 'a'.repeat(64); } },
    async memoryEnabled() { return true; }, async notify() { notices++; }, diagnose() {},
  });
  const signal = new AbortController().signal;
  const first = await ingress.handle(binding, { ...payload, bot_id: binding.botId }, '100-0', signal);
  assert.ok(first?.runId); assert.equal(f.db().messages.length, 1); assert.equal(f.db().startups.length, 1); assert.equal(f.db().dispatches.length, 1);
  assert.equal((f.db().dispatches[0]!.payload as Buffer).includes(Buffer.from('synthetic-user')), false);
  const duplicate = await ingress.handle(binding, { ...payload, bot_id: binding.botId }, '101-0', signal);
  assert.equal(duplicate?.runId, first.runId); assert.equal(f.db().dispatches.length, 1); assert.equal(notices, 2);
  failVersion = true;
  await assert.rejects(ingress.handle(binding, { ...payload, bot_id: binding.botId, message_id: 'second', platform_message_id: 'second' }, '102-0', signal), /IM 会话持久化未完成/);
  assert.equal(f.db().messages.length, 1); assert.equal(f.db().startups.length, 1); assert.equal(f.db().receipts.length, 1);
  control = true;
  assert.equal(await ingress.handle(binding, { ...payload, bot_id: binding.botId, message_id: 'control' }, '103-0', signal), null);
  assert.equal(f.db().messages.length, 1);
});
test('正式Ingress预检后合批只登记一个加密Run，重复整批与部分重领均复用', async () => {
  const f = fixture(); let controls = false, checks = 0, modelCalls = 0, notices = 0;
  const ingress = createPostgresImIngress({ pool: f.pool, secretKey, attachments: { mode: 'text-only' },
    supportedPlatforms: () => ['telegram'], async preflight() { checks++; return controls ? 'consumed' : 'enqueue'; },
    model: { async accessVersion(_identity, actor) { modelCalls++; assert.equal(actor.role, 'owner'); return 'a'.repeat(64); } },
    async memoryEnabled() { return false; }, async notify() { notices++; }, diagnose() {},
  });
  const signal = new AbortController().signal;
  const items = ['one', 'two'].map((message_id, index) => ({ eventId: `${100 + index}-0`, payload: { ...payload,
    bot_id: binding.botId, message_id, platform_message_id: message_id } }));
  for (const item of items) assert.equal(await ingress.prepare(binding, item.payload, item.eventId, signal), true);
  assert.equal(f.db().startups.length, 0);
  const result = await ingress.handleBatch(binding, items, signal);
  assert.equal(result[0]!.segments.length, 1); assert.equal(f.db().messages.length, 2);
  assert.equal(f.db().startups.length, 1); assert.equal(f.db().dispatches.length, 1); assert.equal(modelCalls, 1);
  assert.equal(new Set(f.db().messages.map(row => row.run_id)).size, 1);
  const retry = await ingress.handleBatch(binding, [items[1]!], signal);
  assert.equal(retry[0]!.segments[0]!.duplicate, true); assert.equal(f.db().dispatches.length, 1);
  assert.equal(modelCalls, 1); assert.equal(checks, 2); assert.equal(notices, 2);
  controls = true;
  assert.equal(await ingress.prepare(binding, { ...payload, message_id: 'control' }, '103-0', signal), false);
  assert.equal(f.db().messages.length, 2);
});

test('正式Ingress混合群批次用全部发言人绑定模型权限，不能以末条owner加载私人上下文', async () => {
  const f = fixture(); let checked = 0;
  const ingress = createPostgresImIngress({ pool: f.pool, secretKey, attachments: { mode: 'text-only' },
    supportedPlatforms: () => ['telegram'], async preflight() { return 'enqueue'; },
    model: { async accessVersion(_identity, actor) {
      checked++; assert.equal(actor.role, 'member'); assert.equal(actor.verifiedOwner, false);
      assert.deepEqual(actor.speakerRoles?.map(speaker => speaker.role), ['member', 'member']); return 'a'.repeat(64);
    } }, async memoryEnabled() { return true; }, async notify() {}, diagnose() {},
  });
  const signal = new AbortController().signal;
  const items = ['synthetic-member', 'synthetic-user'].map((platform_user_id, index) => ({ eventId: `${200 + index}-0`, payload: {
    ...payload, bot_id: binding.botId, chat_type: 'group', chat_id: 'synthetic-group', platform_user_id,
    message_id: `group-${index}`, platform_message_id: `group-${index}` } }));
  for (const item of items) assert.equal(await ingress.prepare(binding, item.payload, item.eventId, signal), true);
  await ingress.handleBatch(binding, items, signal);
  assert.equal(checked, 1); assert.equal(f.db().dispatches.length, 1); assert.equal(f.db().messages.length, 2);
});

test('可信准入只复核当前权限和历史，不把已排队文本再次交给新控制交互', async () => {
  const f = fixture(); let controlReads = 0;
  const ingress = createPostgresImIngress({ pool: f.pool, secretKey, attachments: { mode: 'text-only' },
    supportedPlatforms: () => ['telegram'], async preflight() { controlReads++; throw new Error('旧文本不得访问新交互'); },
    model: { async accessVersion() { return 'a'.repeat(64); } }, async memoryEnabled() { return false; }, async notify() {}, diagnose() {},
  });
  const signal = new AbortController().signal, input = { ...payload, bot_id: binding.botId };
  assert.equal(await ingress.prepareAdmitted(binding, input, '100-0', signal), true);
  await ingress.handleBatch(binding, [{ eventId: '100-0', payload: input }], signal);
  assert.equal(controlReads, 0); assert.equal(f.db().dispatches.length, 1);
  f.allow(false);
  await assert.rejects(ingress.prepareAdmitted(binding, { ...input, message_id: 'later' }, '101-0', signal), /IM 权限不可用/);
  assert.equal(controlReads, 0); assert.equal(f.db().messages.length, 1);
  await assert.rejects(ingress.prepareAdmitted({ ...binding, ownerId: 'other' }, input, '101-0', signal));
  assert.equal(f.db().messages.length, 1);
});

test('正式群策略保持Python飞书nullable默认、read依赖需at及微信不开放群的边界', async () => {
  const cases = [
    { platform: 'feishu' as const, policy: { feishu_group_chat_enabled: null, group_read_enabled: true }, reply: true, passive: false },
    { platform: 'feishu' as const, policy: { feishu_group_chat_enabled: false }, reply: false, passive: false },
    { platform: 'telegram' as const, policy: { group_read_enabled: true, group_requires_at: false }, reply: true, passive: false },
    { platform: 'telegram' as const, policy: { group_read_enabled: true, group_requires_at: true }, reply: false, passive: true },
    { platform: 'qq' as const, policy: { group_chat_enabled: false }, reply: false, passive: false },
    { platform: 'wechat' as const, policy: { group_chat_enabled: true }, reply: false, passive: false },
  ];
  for (const row of cases) {
    const f = fixture(); f.platform(row.platform); f.groupPolicy(row.policy);
    const current = { ...binding, platform: row.platform }, message = { ...payload, bot_id: binding.botId, platform: row.platform, chat_type: 'group', chat_id: 'group-policy' };
    const ingress = createPostgresImIngress({ pool: f.pool, secretKey, attachments: { mode: 'text-only' }, supportedPlatforms: () => [row.platform],
      async preflight() { return 'enqueue'; }, model: { async accessVersion() { return 'a'.repeat(64); } },
      async memoryEnabled() { return false; }, async notify() {}, diagnose() {},
    });
    if (!row.reply && !row.passive) await assert.rejects(ingress.prepareAdmitted(current, message, '100-0', new AbortController().signal), /IM 权限不可用/);
    else assert.equal(await ingress.prepareAdmitted(current, message, '100-0', new AbortController().signal), row.reply, row.platform);
    assert.equal(f.db().messages.length, row.passive ? 1 : 0);
    assert.equal(f.db().dispatches.length, 0);
  }
});

test('early不新建会话；已有会话早落行带pending且dispatch复用原行和序号', async () => {
  const f = fixture(), store = f.make();
  assert.equal(await store.persist(binding, payload, { eventId: '100-0', mode: 'early' }), null);
  await store.persist(binding, payload, { eventId: '100-0', mode: 'dispatch', onDispatch: f.dispatch });
  const second = { ...payload, message_id: 'platform-2', platform_message_id: 'platform-2', text: '提前落库' };
  const early = await store.persist(binding, second, { eventId: '101-0', mode: 'early' });
  assert.equal(early!.messageId, 2); assert.match(String(f.db().messages[1]!.run_id), /^im-pending:/);
  const dispatched = await store.persist(binding, second, { eventId: '101-0', mode: 'dispatch', onDispatch: f.dispatch });
  assert.equal(dispatched!.messageId, early!.messageId); assert.equal(dispatched!.conversationSeq, 2); assert.equal(f.db().messages.length, 2); assert.equal(f.db().messages[1]!.run_id, 'run-2');
});

test('被动群记录实际落库并同事务claim，重复不追加、不创建Run；随后主动升级复用原锚点', async () => {
  const f = fixture(); f.classification('passive'); f.attachments();
  const store = f.make(), group = { ...payload, chat_type: 'group', chat_id: 'synthetic-group', attachments: ['attach-a'] };
  const first = await store.persist(binding, group, { eventId: '100-0', mode: 'passive' });
  assert.ok(first); assert.equal(first.runId, null); assert.equal(f.db().messages[0]!.run_id, null);
  assert.equal(f.db().receipts[0]!.state, 'passive'); assert.equal(f.counts().claimCount, 1); assert.equal(f.counts().dispatches, 0);
  const again = await store.persist(binding, group, { eventId: '101-0', mode: 'passive' });
  assert.equal(again!.duplicate, true); assert.equal(f.db().messages.length, 1); assert.equal(f.counts().claimCount, 1);
  f.classification('reply');
  const promoted = await store.persist(binding, group, { eventId: '102-0', mode: 'dispatch', onDispatch: f.dispatch });
  assert.equal(promoted!.messageId, first.messageId); assert.equal(promoted!.runId, 'run-1');
  assert.equal(f.db().messages.length, 1); assert.equal(f.db().receipts[0]!.state, 'dispatched');
  assert.equal(f.counts().dispatches, 1);
});
test('owner/Bot/群/私聊完整隔离，后续消息按会话序号递增且不采信外部sessionId', async () => {
  const f = fixture(), store = f.make();
  const cases = [
    { b: binding, p: payload },
    { b: { ...binding, botId: '72' }, p: { ...payload, channel_id: '72' } },
    { b: { ...binding, ownerId: '00000000-0000-4000-8000-000000000072' }, p: { ...payload, owner_user_id: '00000000-0000-4000-8000-000000000072' } },
    { b: binding, p: { ...payload, chat_type: 'group', chat_id: 'group-a' } },
    { b: binding, p: { ...payload, chat_type: 'group', chat_id: 'group-b' } },
  ];
  for (const item of cases) await store.persist(item.b, item.p, { eventId: '100-0', mode: 'dispatch', sessionId: 1, onDispatch: f.dispatch });
  assert.equal(f.db().sessions.length, 5);
  const next = await store.persist(binding, { ...payload, message_id: 'platform-2', platform_message_id: 'platform-2' }, { eventId: '101-0', mode: 'dispatch', onDispatch: f.dispatch });
  assert.equal(next!.sessionId, 1); assert.equal(next!.conversationSeq, 2);
  assert.ok(f.statements.some(sql => sql.includes('pg_advisory_xact_lock')));
});
test('授权撤销、控制/被动消息、未暂存媒体不产生普通历史，派发失败回滚全部写入', async () => {
  const f = fixture(), store = f.make(); f.allow(false);
  await assert.rejects(store.persist(binding, payload, { eventId: '100-0', mode: 'dispatch', onDispatch: f.dispatch }), error => error instanceof ImConversationError && error.code === 'unauthorized');
  f.allow(true); f.classification('control'); assert.equal(await store.persist(binding, payload, { eventId: '100-0', mode: 'dispatch', onDispatch: f.dispatch }), null);
  f.classification('passive'); assert.equal(await store.persist(binding, payload, { eventId: '100-0', mode: 'early' }), null);
  f.classification('reply'); assert.equal(await store.persist(binding, { ...payload, attachments: [{ pending_media: true }] }, { eventId: '100-0', mode: 'early' }), null);
  f.failDispatch(); await assert.rejects(store.persist(binding, payload, { eventId: '100-0', mode: 'dispatch', onDispatch: f.dispatch }), { message: 'IM 会话持久化未完成' });
  assert.equal(f.db().sessions.length, 0); assert.equal(f.db().messages.length, 0); assert.equal(f.db().receipts.length, 0); assert.equal(f.counts().notified, 0);
});
test('附件早落库不claim，dispatch同事务claim；text-only明确拒绝附件', async () => {
  const f = fixture(); f.attachments(); const store = f.make();
  await store.persist(binding, payload, { eventId: '100-0', mode: 'dispatch', onDispatch: f.dispatch });
  const attached = { ...payload, message_id: 'platform-2', platform_message_id: 'platform-2', attachments: ['synthetic-attachment'] };
  await store.persist(binding, attached, { eventId: '101-0', mode: 'early' }); assert.equal(f.counts().claimCount, 0);
  await store.persist(binding, attached, { eventId: '101-0', mode: 'dispatch', onDispatch: f.dispatch }); assert.equal(f.counts().claimCount, 1);
  const text = fixture(); await assert.rejects(text.make().persist(binding, attached, { eventId: '101-0', mode: 'dispatch', onDispatch: text.dispatch }), ImConversationError); assert.equal(text.db().messages.length, 0);
});

const batchItem = (id: string, text: string, extra: Row = {}) => ({ eventId: `${id}-0`, payload: { ...payload,
  chat_type: 'group', chat_id: 'synthetic-group', message_id: id, platform_message_id: id, text, ...extra } });

test('批次逐消息锚点共享唯一Run，按平台时间保留speaker/body/引用/最后原生回复路由', async () => {
  const f = fixture(), store = f.make();
  const items = [batchItem('300', '第三条', { platform_sent_ms: 300, platform_user_id: 'synthetic-member' }),
    batchItem('100', '第一条', { platform_sent_ms: 100, platform_user_id: 'synthetic-owner', quoted_text: '合成引用' }),
    batchItem('200', '第二条', { platform_sent_ms: 200, platform_user_id: 'synthetic-member' })];
  let dispatched = 0;
  const result = await store.persistBatch(binding, items, { mode: 'dispatch', async onDispatch(_client, segment) {
    dispatched++; assert.equal(segment.aggregate.text, '第一条\n第二条\n第三条');
    assert.deepEqual((segment.aggregate._batch_messages as Row[]).map(row => row.platform_user_id), ['synthetic-owner', 'synthetic-member', 'synthetic-member']);
    assert.equal(segment.aggregate.message_id, '300'); assert.equal(segment.aggregate.platform_user_id, 'synthetic-member');
    assert.equal((segment.aggregate._batch_messages as Row[])[0]!.quoted_text, '合成引用');
    return 'batch-run';
  } });
  assert.equal(result.segments.length, 1); assert.equal(dispatched, 1);
  assert.equal(f.db().messages.length, 3); assert.equal(f.db().segments.length, 1); assert.equal(f.db().members.length, 3);
  assert.ok(f.db().messages.every(row => row.run_id === 'batch-run'));
  assert.ok(!JSON.stringify(f.db().segments).includes('synthetic-reply-secret'));
  const retry = await store.persistBatch(binding, items.map(p => ({ ...p, eventId: `${Number(p.eventId.split('-')[0]) + 1000}-0` })),
    { mode: 'dispatch', async onDispatch() { throw new Error('已完成的段不能重放'); } });
  assert.equal(retry.segments[0]!.duplicate, true); assert.equal(retry.segments[0]!.runId, 'batch-run');
  assert.equal(f.db().messages.length, 3);
  const route = await store.readRoute({ ownerId: owner, sessionId: '1', runId: 'batch-run' });
  assert.deepEqual(route.payload._inbound_batch, result.segments[0]!.aggregate._inbound_batch);
  assert.equal((route.payload._batch_messages as Row[]).length, 3);
});

test('逐段派发失败保留started和后段锚点，重启重放只补未完成段', async () => {
  const f = fixture(), store = f.make(), calls: number[] = [];
  const items = [batchItem('100', '普通前段'), batchItem('200', '独立mention', { bot_mentioned: true }), batchItem('300', '普通后段')];
  let fail = true;
  const onDispatch = async (_client: PoolClient, segment: { index: number }) => {
    calls.push(segment.index);
    if (segment.index === 1 && fail) throw new Error('合成故障');
    return `segment-run-${segment.index}`;
  };
  await assert.rejects(store.persistBatch(binding, items, { mode: 'dispatch', onDispatch }), /IM 会话持久化未完成/);
  assert.deepEqual(f.db().segments.map(row => row.state), ['completed', 'started', 'started']);
  assert.equal(f.db().messages.length, 3);
  assert.equal(f.db().messages[0]!.run_id, 'segment-run-0'); assert.match(String(f.db().messages[1]!.run_id), /^im-pending:/);
  await assert.rejects(store.persist(binding, items[1]!.payload, { eventId: '200-0', mode: 'dispatch', onDispatch: f.dispatch }),
    error => error instanceof ImConversationError && error.code === 'conflict');
  fail = false;
  const recovered = await f.make().persistBatch(binding, items, { mode: 'dispatch', onDispatch });
  assert.deepEqual(calls, [0, 1, 1, 2]); assert.equal(recovered.segments[0]!.duplicate, true);
  assert.ok(f.db().segments.every(row => row.state === 'completed')); assert.equal(f.db().messages.length, 3);
});

test('只重领started段部分成员仍恢复原段全部事实，不按新队列分组重复派发', async () => {
  const f = fixture(), store = f.make(), items = [batchItem('100', '第一条'), batchItem('200', '第二条')];
  await assert.rejects(store.persistBatch(binding, items, { mode: 'dispatch', async onDispatch() { throw new Error('合成故障'); } }));
  const recovered = await store.persistBatch(binding, [items[1]!], { mode: 'dispatch', async onDispatch(_client, segment) {
    assert.equal(segment.anchors.length, 2); assert.equal(segment.aggregate.text, '第一条\n第二条'); return 'recovered-run';
  } });
  assert.equal(recovered.segments.length, 1); assert.equal(f.db().segments.length, 1); assert.equal(f.db().messages.length, 2);
  await assert.rejects(store.persistBatch(binding, [{ ...items[0]!, payload: { ...items[0]!.payload, text: '篡改正文' } }],
    { mode: 'dispatch', async onDispatch() { return 'forbidden'; } }), error => error instanceof ImConversationError && error.code === 'conflict');
});

test('early历史序号保持不变，batch messageIds保存业务顺序且最后锚点决定dispatch入口', async () => {
  const f = fixture(), store = f.make();
  await store.persist(binding, batchItem('50', '已有群历史').payload, { eventId: '50-0', mode: 'dispatch', onDispatch: f.dispatch });
  const later = batchItem('100', '较晚平台消息', { platform_sent_ms: 300 }), earlier = batchItem('200', '较早平台消息', { platform_sent_ms: 100 });
  await store.persist(binding, later.payload, { eventId: later.eventId, mode: 'early' });
  await store.persist(binding, earlier.payload, { eventId: earlier.eventId, mode: 'early' });
  const result = await store.persistBatch(binding, [later, earlier], { mode: 'dispatch', async onDispatch(_client, segment) {
    assert.deepEqual(segment.anchors.map(a => a.messageId), [3, 2]);
    assert.deepEqual(segment.anchors.map(a => a.conversationSeq), [3, 2]);
    assert.equal(segment.aggregate.text, '较早平台消息\n较晚平台消息'); return 'ordered-run';
  } });
  assert.deepEqual((result.segments[0]!.aggregate._inbound_batch as Row).messageIds, [3, 2]);
  assert.equal(f.db().messages.length, 3);
});

test('批次当前授权撤销使派发事务回滚，started可恢复；跨scope拒绝且附件按原消息claim', async () => {
  const f = fixture(); f.attachments(); const store = f.make();
  const items = [batchItem('100', '带附件一', { attachments: ['attach-a'] }), batchItem('200', '带附件二', { attachments: ['attach-b'] })];
  await assert.rejects(store.persistBatch(binding, items, { mode: 'dispatch', async onDispatch() { f.allow(false); return 'revoked-run'; } }),
    error => error instanceof ImConversationError && error.code === 'unauthorized');
  assert.equal(f.db().segments[0]!.state, 'started'); assert.ok(f.db().messages.every(row => String(row.run_id).startsWith('im-pending:')));
  f.allow(true);
  const result = await store.persistBatch(binding, items, { mode: 'dispatch', async onDispatch() { return 'authorized-run'; } });
  assert.equal(result.segments[0]!.runId, 'authorized-run'); assert.equal(f.db().messages.length, 2);
  assert.deepEqual((result.segments[0]!.aggregate._batch_messages as Row[]).map(row => row.attachments), [['attach-a'], ['attach-b']]);
  const before = f.db().messages.length;
  await assert.rejects(store.persistBatch(binding, [batchItem('300', '群A'), batchItem('400', '群B', { chat_id: 'another-group' })],
    { mode: 'dispatch', async onDispatch() { return 'forbidden'; } }), error => error instanceof ImConversationError && error.code === 'invalid_input');
  assert.equal(f.db().messages.length, before);
});

test('被动批次持久completed无Run，重复不claim或改写历史', async () => {
  const f = fixture(); f.classification('passive'); f.attachments(); const store = f.make();
  const items = [batchItem('100', '被动一', { attachments: ['attach-a'] }), batchItem('200', '被动二')];
  const initial = await store.persistBatch(binding, items, { mode: 'passive' });
  assert.equal(initial.segments[0]!.runId, null); assert.equal(f.db().segments[0]!.state, 'completed');
  assert.ok(f.db().receipts.every(row => row.state === 'passive')); assert.equal(f.counts().claimCount, 1);
  const repeated = await store.persistBatch(binding, items, { mode: 'passive' });
  assert.equal(repeated.segments[0]!.duplicate, true); assert.equal(f.counts().claimCount, 1); assert.equal(f.db().messages.length, 2);
});

test('更晚批次不能越过较早started段，恢复后FIFO派发；Run不能借给其他消息', async () => {
  const f = fixture(), store = f.make(), earlier = [batchItem('100', '较早段')], later = [batchItem('200', '较晚段')];
  await assert.rejects(store.persistBatch(binding, earlier, { mode: 'dispatch', async onDispatch() { throw new Error('合成故障'); } }));
  let laterCalls = 0;
  await assert.rejects(store.persistBatch(binding, later, { mode: 'dispatch', async onDispatch() { laterCalls++; return 'later-run'; } }),
    error => error instanceof ImConversationError && error.code === 'conflict');
  assert.equal(laterCalls, 0); assert.equal(f.db().messages.length, 2);
  await store.persistBatch(binding, earlier, { mode: 'dispatch', async onDispatch() { return 'earlier-run'; } });
  await assert.rejects(store.persistBatch(binding, later, { mode: 'dispatch', async onDispatch() { return 'earlier-run'; } }),
    error => error instanceof ImConversationError && error.code === 'conflict');
  assert.equal(f.db().segments[1]!.state, 'started');
  await store.persistBatch(binding, later, { mode: 'dispatch', async onDispatch() { laterCalls++; return 'later-run'; } });
  assert.equal(laterCalls, 1); assert.deepEqual(f.db().messages.map(row => row.run_id), ['earlier-run', 'later-run']);
  await assert.rejects(store.persist(binding, batchItem('300', '单消息不能复用已占用Run').payload,
    { eventId: '300-0', mode: 'dispatch', async onDispatch() { return 'later-run'; } }),
  error => error instanceof ImConversationError && error.code === 'conflict');
});

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL;

test('隔离PG：注意力门的持久被动/等待、重放与事务复核', { skip: !pgUrl && '需显式隔离PG；不以query替身代替事务验收', timeout: 30000 }, async t => {
  const { Pool } = await import('pg'), schema = `im_attention_gate_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: pgUrl }); let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}`, max: 5 });
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid REFERENCES users(id),platform text,enabled boolean,policy_class text,config_version integer);
      CREATE TABLE conversation_sessions(id serial PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),title text,title_locked boolean,summary text,source text,bot_id varchar(128),chat_id text,platform_user_id text,chat_type text,context_epoch integer,baseline_message_seq bigint,last_message_seq bigint,execution_state text,pending_message_count integer,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE conversation_messages(id serial PRIMARY KEY,session_id integer REFERENCES conversation_sessions(id),conversation_seq bigint,role text,content text,client_message_id varchar(64),files jsonb,quoted_text text,platform_user_id text,platform_user_name text,platform_bot_user_id text,chat_type text,im_platform_message_id text,im_reply_to_message_id text,im_reply_target_sender_id text,im_reply_target_is_bot boolean,im_sender_is_bot boolean,im_event_received_ms bigint,im_platform_sent_ms bigint,run_id text,created_at timestamptz,sent_at timestamptz,UNIQUE(session_id,conversation_seq),UNIQUE(session_id,client_message_id));
      CREATE TABLE dispatches(run_id text PRIMARY KEY,message_id integer)`);
    await pool.query(imGatewaySql.conversation);
    const db = pool, envelope = createImInboundEnvelope(secretKey);
    async function reset() {
      await db.query('TRUNCATE dispatches,gugu_im_inbound_batch_members,gugu_im_inbound_segments,gugu_im_inbound_receipts,conversation_messages,conversation_sessions,user_bots,users CASCADE');
      await db.query('INSERT INTO users VALUES($1,true)', [owner]);
      await db.query("INSERT INTO user_bots VALUES(71,$1,'telegram',true,'reply',1)", [owner]);
    }
    const make = () => createPostgresImConversationStore({ pool: db, secretKey, attachments: { mode: 'text-only' },
      authorize: async (client, b) => (await client.query(`SELECT 1 FROM user_bots b JOIN users u ON u.id=b.user_id
        WHERE b.id=$1 AND b.user_id=$2 AND b.platform=$3 AND b.enabled AND u.is_active FOR SHARE OF b,u`, [b.botId, b.ownerId, b.platform])).rowCount === 1,
      classify: async client => (await client.query('SELECT policy_class FROM user_bots WHERE id=71')).rows[0].policy_class,
    });
    const items = (): Array<{ eventId: string; payload: Record<string, unknown> }> => [{ eventId: '1791000000000-1', payload: { ...payload, chat_type: 'group', chat_id: 'synthetic-attention-room' } }];
    const record = (disposition: ImAttentionRecord['disposition'], configVersion = 1): ImAttentionRecord => ({ v: 1, disposition, mode: 'natural', configVersion,
      subjectEventId: disposition === 'run' ? '1791000000000-1' : null, sourceAttentionKind: disposition === 'run' ? 'autonomous' : null, proactive: false,
      replyChoice: disposition === 'run' ? 'pending' : 'reply' });
    const validateAttention = async (client: PoolClient, r: ImAttentionRecord) => (await client.query('SELECT config_version FROM user_bots WHERE id=71 FOR SHARE')).rows[0].config_version === r.configVersion;
    const dispatch = async (client: PoolClient, segment: { anchors: ImConversationAnchor[] }) => {
      const id = segment.anchors.at(-1)!.messageId, runId = `attention-${id}`;
      await client.query('INSERT INTO dispatches VALUES($1,$2)', [runId, id]); return runId;
    };
    for (const disposition of ['passive', 'pending'] as const) await t.test(`${disposition}完成不派Run；配置放宽重投不重评估、不升级`, async () => {
      await reset(); const store = make(); let decisions = 0;
      const input = { mode: 'dispatch' as const, beforeDispatch: async () => { decisions++; return record(disposition); }, validateAttention, onDispatch: dispatch };
      const first = await store.persistBatch(binding, items(), input);
      assert.equal(first.segments[0]!.runId, null); assert.equal(decisions, 1);
      const stored = (await db.query('SELECT * FROM gugu_im_inbound_segments')).rows[0];
      assert.equal(stored.mode, 'passive'); assert.equal(stored.state, 'completed');
      assert.equal((envelope.open(binding, stored.sealed_payload)._node_attention as ImAttentionRecord).disposition, disposition);
      await db.query('UPDATE user_bots SET config_version=2');
      const replayed = await store.persistBatch(binding, [{ ...items()[0]!, eventId: '1791000000100-0' }], { ...input, beforeDispatch: async () => { assert.fail('已完成旧段不得重新求值'); } });
      assert.equal(replayed.segments[0]!.runId, null); assert.equal(replayed.segments[0]!.duplicate, true);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM dispatches')).rows[0].n, 0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM conversation_messages')).rows[0].n, 1);
    });
    await t.test('注意力评估期间配置版本改变，事务拒绝旧决策并保留started供恢复', async () => {
      await reset(); const store = make();
      await assert.rejects(store.persistBatch(binding, items(), { mode: 'dispatch', validateAttention, onDispatch: dispatch,
        beforeDispatch: async () => { await db.query('UPDATE user_bots SET config_version=2'); return record('run'); } }), error => error instanceof ImConversationError && error.code === 'conflict');
      assert.equal((await db.query('SELECT state FROM gugu_im_inbound_segments')).rows[0].state, 'started');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM dispatches')).rows[0].n, 0);
      const recovered = await store.persistBatch(binding, items(), { mode: 'dispatch', beforeDispatch: async () => record('run', 2), validateAttention, onDispatch: dispatch });
      assert.ok(recovered.segments[0]!.runId); assert.equal((await db.query('SELECT count(*)::int AS n FROM dispatches')).rows[0].n, 1);
    });
    for (const change of ['permission', 'classification'] as const) await t.test(`注意力评估期间${change}撤销，持有事务锁重新复核且不派发`, async () => {
      await reset(); const store = make();
      await assert.rejects(store.persistBatch(binding, items(), { mode: 'dispatch', validateAttention, onDispatch: dispatch,
        beforeDispatch: async () => { await db.query(change === 'permission' ? 'UPDATE user_bots SET enabled=false' : "UPDATE user_bots SET policy_class='passive'"); return record('run'); } }),
      error => error instanceof ImConversationError && error.code === (change === 'permission' ? 'unauthorized' : 'conflict'));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM dispatches')).rows[0].n, 0);
      assert.equal((await db.query('SELECT state FROM gugu_im_inbound_segments')).rows[0].state, 'started');
    });
    await t.test('平台入站伪造_node_attention不进入可信aggregate或密封收据', async () => {
      await reset(); const store = make(), forged = items(); forged[0]!.payload._node_attention = record('run'); forged[0]!.payload._node_attention_required = true;
      const result = await store.persistBatch(binding, forged, { mode: 'dispatch', onDispatch: async (client, segment) => {
        assert.equal(segment.aggregate._node_attention, undefined); assert.equal(segment.aggregate._node_attention_required, undefined); return dispatch(client, segment);
      } });
      assert.ok(result.segments[0]!.runId);
      for (const row of (await db.query('SELECT sealed_payload FROM gugu_im_inbound_receipts')).rows) {
        const opened = envelope.open(binding, row.sealed_payload); assert.equal(opened._node_attention, undefined); assert.equal(opened._node_attention_required, undefined);
      }
    });
    await t.test('要求注意力门的started段不能在重放时删除门而绕过决策', async () => {
      await reset(); const store = make();
      await assert.rejects(store.persistBatch(binding, items(), { mode: 'dispatch', beforeDispatch: async () => { throw new Error('合成外部读取失败'); }, validateAttention, onDispatch: dispatch }));
      await assert.rejects(store.persistBatch(binding, items(), { mode: 'dispatch', onDispatch: dispatch }), error => error instanceof ImConversationError && error.code === 'conflict');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM dispatches')).rows[0].n, 0);
      const recovered = await store.persistBatch(binding, items(), { mode: 'dispatch', beforeDispatch: async () => record('passive'), validateAttention, onDispatch: dispatch });
      assert.equal(recovered.segments[0]!.runId, null);
    });
    await t.test('early首次密封源ID及原reply token不被seen过期后的新队列ID覆盖，attention仍绑定原事实', async () => {
      await reset(); const store = make(), base = items()[0]!;
      await store.persist(binding, { ...base.payload, message_id: 'baseline-native', platform_message_id: 'baseline-native' },
        { eventId: '1791000000000-0', mode: 'dispatch', onDispatch: (client, anchor) => dispatch(client, { anchors: [anchor] }) });
      const firstId = '1791000000100-0', first = { ...base.payload, message_id: 'early-stream-native', platform_message_id: 'early-stream-native', context_token: 'synthetic-original-reply-context' };
      const early = await store.persist(binding, first, { eventId: firstId, mode: 'early' }); assert.ok(early);
      const result = await store.persistBatch(binding, [{ eventId: '1791000000200-0', payload: { ...first, context_token: 'synthetic-later-reply-context' } }], {
        mode: 'dispatch', beforeDispatch: async segment => {
          const facts = segment.aggregate._batch_messages as Record<string, unknown>[];
          assert.equal(facts[0]!._node_stream_event_id, firstId); assert.equal(segment.aggregate._node_stream_event_id, firstId);
          assert.equal(facts[0]!.context_token, 'synthetic-original-reply-context'); assert.equal(segment.aggregate.context_token, 'synthetic-original-reply-context');
          return { ...record('run'), subjectEventId: firstId };
        }, validateAttention, onDispatch: dispatch,
      });
      assert.equal(result.segments[0]!.anchors[0]!.messageId, early.messageId);
      assert.equal((result.segments[0]!.aggregate._node_attention as ImAttentionRecord).subjectEventId, firstId);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM conversation_messages')).rows[0].n, 2);
    });
    await t.test('真实Ingress/PG/Redis注意力→冻结v3派发；非末条subject保留全speaker最低权限且重投不增Run', {
      skip: !process.env.GUGU_IM_GATEWAY_TEST_REDIS_URL && '需要显式隔离Redis；不使用pending或snapshot替身',
    }, async () => {
      await reset();
      await db.query(`ALTER TABLE users ADD account_status text DEFAULT 'active';
        ALTER TABLE user_bots ADD owner_platform_user_id text DEFAULT '8181',ADD group_allowed_tools json DEFAULT '["read_file","send_item"]',
          ADD group_owner_memory_enabled boolean DEFAULT true,ADD group_chat_enabled boolean DEFAULT true,ADD feishu_group_chat_enabled boolean,
          ADD group_requires_at boolean DEFAULT false,ADD group_read_enabled boolean DEFAULT false,ADD group_attention_mode text DEFAULT 'natural',
          ADD group_attention_config_version integer DEFAULT 3,ADD name text DEFAULT '合成咕咕';
        CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
        CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id text,state text,nonce bytea,payload bytea,request_expires_at timestamptz,message_id integer,UNIQUE(user_id,session_id,run_id));`);
      await db.query('ALTER TABLE conversation_sessions ADD session_context jsonb');
      await db.query(imGatewaySql.delivery);
      await db.query(imGatewaySql.attentionLedger);
      const commands = createRedisStreamCommands(process.env.GUGU_IM_GATEWAY_TEST_REDIS_URL!), touched = new Set<string>(), index = 'im:node:{pending-ask}:due:v1';
      const redis = { async sendCommand(parts: string[]) {
        if (parts[0] === 'EVAL') for (const key of parts.slice(3, 3 + Number(parts[2]))) if (key !== index) touched.add(key);
        return commands.sendCommand(parts);
      } };
      const groupId = `synthetic-ingress-${randomUUID()}`, now = Date.now(), signal = new AbortController().signal;
      const keys = nodeImAttentionKeys(binding, groupId);
      try {
        // 合成Node inbox覆盖起点；Redis、pending Lua、密封历史和accepted事实reader均为实际实现。
        await redis.sendCommand(['EVAL', "redis.call('SET',KEYS[1],ARGV[1],'EX',1800); return 1", '1', keys.start, String(now - 700000)]);
        const pending = createRedisImPendingAskStore({ redis, secretKey, now: () => now + 2 });
        const snapshot = createPostgresRedisImAttentionSnapshot({ pool: db, redis, secretKey, acceptedFacts: createPostgresImAcceptedFactsReader({ pool: db, secretKey }) });
        const runtime = createPostgresImAttentionRuntime({ pool: db, snapshot, pending, now: () => now + 2 });
        let evaluations = 0, bindings = 0;
        const ingress = createPostgresImIngress({ pool: db, secretKey, supportedPlatforms: () => ['telegram'], attachments: { mode: 'text-only' },
          preflight: async () => { throw new Error('可信准入不应重复控制预检'); },
          attention: { async evaluate(...args) { evaluations++; return runtime.evaluate(...args); } },
          // 唯一业务替身为模型scope版本读取；不调用Provider或启动Harness。
          model: { async accessVersion(_identity, actor) {
            bindings++; assert.equal(actor.role, 'member'); assert.equal(actor.verifiedOwner, false);
            assert.equal(actor.platformUserId, '8181'); assert.deepEqual(actor.allowedToolNames, ['send_item']);
            assert.deepEqual(actor.speakerRoles?.map(s => s.role), ['member', 'member']); return 'a'.repeat(64);
          } }, memoryEnabled: async () => true, async notify() {}, diagnose() {},
        });
        const batch = [
          { eventId: `${now}-1`, payload: { ...payload, bot_id: binding.botId, chat_type: 'group', chat_id: groupId,
            platform_user_id: '9191', message_id: '901', platform_message_id: '901', text: '帮我创建一个项目', native_bot_mentioned: false } },
          { eventId: `${now}-2`, payload: { ...payload, bot_id: binding.botId, chat_type: 'group', chat_id: groupId,
            platform_user_id: '8181', message_id: '902', platform_message_id: '902', text: '谢谢', native_bot_mentioned: false } },
        ];
        for (const item of batch) assert.equal(await ingress.prepareAdmitted(binding, item.payload, item.eventId, signal), true);
        const handled = await ingress.handleBatch(binding, batch, signal), segment = handled[0]!.segments[0]!;
        assert.ok(segment.runId); assert.equal(evaluations, 1); assert.equal(bindings, 1);
        const rows = (await db.query('SELECT * FROM agent_run_dispatch')).rows; assert.equal(rows.length, 1);
        const row = rows[0]!, identity = { ownerId: owner, sessionId: String(row.session_id), runId: row.run_id };
        const dispatch = decryptAgentDispatchInput(secretKey, identity, row.nonce, row.payload);
        assert.equal(dispatch.v, 3); assert.equal(dispatch.source, 'im');
        if (dispatch.v !== 3 || dispatch.source !== 'im') assert.fail('必须持久v3 IM来源');
        assert.equal(dispatch.im.platformUserId, '8181'); assert.equal(dispatch.im.attention?.subjectEventId, batch[0]!.eventId);
        assert.equal(dispatch.im.attention?.sourceAttentionKind, 'CAPABILITY_ACTION'); assert.equal(dispatch.im.attention?.configVersion, 3);
        assert.equal(dispatch.userMessageId, segment.anchors.at(-1)!.messageId);
        assert.deepEqual(dispatch.im.batch?.messageIds, segment.anchors.map(a => a.messageId));
        const replayed = await ingress.handleBatch(binding, batch, signal);
        assert.equal(replayed[0]!.segments[0]!.duplicate, true); assert.equal(evaluations, 1); assert.equal(bindings, 1);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_run_dispatch')).rows[0].n, 1);
        const quiet = { eventId: `${now + 1}-1`, payload: { ...batch[1]!.payload, message_id: '903', platform_message_id: '903', text: '谢谢' } };
        assert.equal(await ingress.prepareAdmitted(binding, quiet.payload, quiet.eventId, signal), true);
        const quietResult = await ingress.handleBatch(binding, [quiet], signal);
        assert.equal(quietResult[0]!.segments[0]!.runId, null);
        await db.query('UPDATE user_bots SET group_requires_at=true,group_read_enabled=true,group_attention_config_version=4');
        assert.equal(await ingress.prepareAdmitted(binding, quiet.payload, `${now + 2}-1`, signal), false);
        assert.equal(await ingress.prepareAdmitted(binding, batch[0]!.payload, `${now + 2}-2`, signal), false);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_run_dispatch')).rows[0].n, 1); assert.equal(bindings, 1);
        const goals = createPostgresImIngress({ pool: db, secretKey, supportedPlatforms: () => ['telegram'],
          attachments: { mode: 'text-only' }, preflight: async () => 'enqueue',
          attention: { async evaluate() { assert.fail('明确的所有者命令不应经过群注意力模型') } },
          model: { async accessVersion(_identity, actor) {
            assert.equal(actor.role, 'owner')
            return 'a'.repeat(64)
          } }, memoryEnabled: async () => true, async notify() {}, diagnose() {},
        })
        const goal = { eventId: `${now + 3}-1`, payload: { ...batch[1]!.payload, chat_id: 'synthetic-goal-room',
          message_id: '904', platform_message_id: '904', bot_mentioned: true, native_bot_mentioned: true,
          text: '@咕咕 /goal 整理测试材料' } }
        const memberGoal = { eventId: `${now + 3}-2`, payload: { ...goal.payload, platform_user_id: '9191',
          message_id: '905', platform_message_id: '905', text: '@咕咕 /goal 替换目标' } }
        assert.equal(await goals.prepareAdmitted(binding, memberGoal.payload, memberGoal.eventId, signal), false)
        assert.equal(await goals.prepareAdmitted(binding, goal.payload, goal.eventId, signal), true)
        const goalResult = await goals.handleBatch(binding, [goal, memberGoal], signal)
        assert.ok(goalResult[0]?.segments[0]?.runId)
        const goalState = (await db.query('SELECT session_context FROM conversation_sessions WHERE chat_id=$1', [goal.payload.chat_id])).rows[0]
        assert.deepEqual(goalState.session_context, { goal_text: '整理测试材料', goal_mode: true, goal_status: 'active' })

      } finally {
        await commands.sendCommand(['EVAL', "for i=1,#KEYS-1 do redis.call('DEL',KEYS[i]); local id=string.match(KEYS[i],':v1:([a-f0-9]+)$'); if id then redis.call('ZREM',KEYS[#KEYS],id) end end; return 1", String(touched.size + 1), ...touched, index]);
        await commands.close();
      }
    });
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
test('隔离PG：真实并发路由锁、事务回滚、历史去重和密封route归属', { skip: !pgUrl && '需显式隔离PG连接；query替身不代表真实并发与持久化验收' }, async () => {
  const { Pool } = await import('pg'); const schema = `im_conversation_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: pgUrl }); let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid NOT NULL,platform text NOT NULL,enabled boolean NOT NULL);
      CREATE TABLE conversation_sessions(id serial PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),title text,title_locked boolean,summary text,source text,bot_id text,chat_id text,platform_user_id text,chat_type text,context_epoch integer,baseline_message_seq bigint,last_message_seq bigint,execution_state text,pending_message_count integer,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE conversation_messages(id serial PRIMARY KEY,session_id integer REFERENCES conversation_sessions(id),conversation_seq bigint,role text,content text,client_message_id varchar(64),files jsonb,quoted_text text,platform_user_id text,platform_user_name text,platform_bot_user_id text,chat_type text,im_platform_message_id text,im_reply_to_message_id text,im_reply_target_sender_id text,im_reply_target_is_bot boolean,im_sender_is_bot boolean,im_event_received_ms bigint,im_platform_sent_ms bigint,run_id text,created_at timestamptz,sent_at timestamptz,UNIQUE(session_id,conversation_seq),UNIQUE(session_id,client_message_id));`);
    await pool.query('INSERT INTO users VALUES($1)', [owner]); await pool.query("INSERT INTO user_bots VALUES(71,$1,'telegram',true)", [owner]);
    await pool.query(imGatewaySql.conversation);
    let dispatched = 0;
    const store = createPostgresImConversationStore({ pool, secretKey, attachments: { mode: 'text-only' }, authorize: async (client, b) => (await client.query('SELECT 1 FROM user_bots WHERE id=$1 AND user_id=$2 AND enabled IS TRUE', [Number(b.botId), b.ownerId])).rowCount === 1, classify: async () => 'reply' });
    const dispatch = async (_client: PoolClient, anchor: ImConversationAnchor) => { dispatched++; return `run-${anchor.messageId}`; };
    const [a, b] = await Promise.all([store.persist(binding, { ...payload, _node_stream_event_id: '999999-0' }, { eventId: '100-0', mode: 'dispatch', onDispatch: dispatch }), store.persist(binding, payload, { eventId: '101-0', mode: 'dispatch', onDispatch: dispatch })]);
    assert.equal(a!.messageId, b!.messageId); assert.equal(dispatched, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM conversation_messages')).rows[0].count, 1);
    await assert.rejects(store.persist(binding, { ...payload, message_id: 'platform-2', platform_message_id: 'platform-2' }, { eventId: '102-0', mode: 'dispatch', onDispatch: async () => { throw new Error('合成失败'); } }), ImConversationError);
    assert.equal((await pool.query('SELECT last_message_seq::int AS value FROM conversation_sessions')).rows[0].value, 1);
    const storedRoute = (await store.readRoute({ ownerId: owner, sessionId: String(a!.sessionId), runId: a!.runId! })).payload;
    assert.equal(storedRoute.context_token, payload.context_token);
    assert.ok(['100-0', '101-0'].includes(String(storedRoute._node_stream_event_id)));
    const batch = [batchItem('300', '真实PG批次一'), batchItem('400', '真实PG批次二')];
    let batchDispatches = 0;
    const dispatchBatch = async (_client: PoolClient, segment: { anchors: ImConversationAnchor[] }) => {
      batchDispatches++; return `pg-batch-${segment.anchors.at(-1)!.messageId}`;
    };
    const [ba, bb] = await Promise.all([store.persistBatch(binding, batch, { mode: 'dispatch', onDispatch: dispatchBatch }),
      store.persistBatch(binding, batch, { mode: 'dispatch', onDispatch: dispatchBatch })]);
    assert.equal(batchDispatches, 1); assert.equal(ba.segments[0]!.runId, bb.segments[0]!.runId);
    const segment = ba.segments[0]!, batchRoute = await store.readRoute({ ownerId: owner, sessionId: String(segment.anchors[0]!.sessionId), runId: segment.runId! });
    assert.equal((batchRoute.payload._batch_messages as Row[]).length, 2);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM conversation_messages WHERE run_id=$1", [segment.runId])).rows[0].count, 2);
    // 真实成功history/stage先持Session；另一入站持scope等Session时，读completed材料不能反向拿scope。
    const reader=await pool.connect();let replay:ReturnType<typeof store.persistBatch>|null=null;
    try{
      await reader.query('BEGIN');await reader.query('SET LOCAL statement_timeout=3000');
      await reader.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR NO KEY UPDATE',[segment.anchors[0]!.sessionId]);
      const pid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      replay=store.persistBatch(binding,batch,{mode:'dispatch',onDispatch:async()=>assert.fail('完成批次不得重派Run')});
      for(let attempt=0;;attempt++){
        if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount)break;
        if(attempt>2000)assert.fail('入站未进入真实Session锁等待');await new Promise<void>(resolve=>setImmediate(resolve));
      }
      const locked=await store.readRouteLocked(reader,{ownerId:owner,sessionId:String(segment.anchors[0]!.sessionId),runId:segment.runId!});
      assert.deepEqual(locked.payload._inbound_batch,batchRoute.payload._inbound_batch);
      assert.equal((locked.payload._batch_messages as Row[]).length,2);
      await reader.query('COMMIT');assert.equal((await replay).segments[0]!.duplicate,true);
    }finally{await reader.query('ROLLBACK');reader.release();await replay;}
    const pending = [batchItem('500', 'PG失败前段'), batchItem('600', 'PG失败后段', { bot_mentioned: true })];
    await assert.rejects(store.persistBatch(binding, pending, { mode: 'dispatch', async onDispatch(_client, candidate) {
      if (candidate.index === 1) throw new Error('合成后段失败'); return 'pg-segment-first';
    } }), ImConversationError);
    const completedBefore = (await pool.query("SELECT count(*)::int AS count FROM gugu_im_inbound_segments WHERE state='completed'")).rows[0].count;
    const recovered = await store.persistBatch(binding, [pending[1]!], { mode: 'dispatch', async onDispatch() { return 'pg-segment-second'; } });
    assert.equal(recovered.segments[0]!.runId, 'pg-segment-second');
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM gugu_im_inbound_segments WHERE state='completed'")).rows[0].count, completedBefore + 1);
    const numeric = { ...payload, message_id: '9281', platform_message_id: undefined };
    const numericAnchor = await store.persist(binding, numeric, { eventId: 'numeric-alias', mode: 'dispatch', onDispatch: dispatch });
    assert.equal((await pool.query('SELECT im_platform_message_id FROM conversation_messages WHERE id=$1', [numericAnchor!.messageId])).rows[0].im_platform_message_id, '9281');
    await pool.query("INSERT INTO user_bots VALUES(72,$1,'wechat',true)", [owner]);
    const wx = { ...payload, platform: 'wechat', channel_id: '72', message_id: 'synthetic-private-context', context_token: 'synthetic-private-context', platform_message_id: undefined };
    const wxAnchor = await store.persist({ ...binding, platform: 'wechat', botId: '72' }, wx, { eventId: 'wx-no-plaintext', mode: 'dispatch', onDispatch: dispatch });
    assert.equal((await pool.query('SELECT im_platform_message_id FROM conversation_messages WHERE id=$1', [wxAnchor!.messageId])).rows[0].im_platform_message_id, null);
    // 普通旧事件不会因策略放宽或伪造恢复布尔字段升级；内部显式派发契约仍由上方原有回归保护。
    await pool.query(`ALTER TABLE users ADD is_active boolean DEFAULT true,ADD account_status text DEFAULT 'active';
      ALTER TABLE user_bots ADD owner_platform_user_id text,ADD group_allowed_tools json DEFAULT '[]',
        ADD group_owner_memory_enabled boolean DEFAULT false,ADD group_chat_enabled boolean DEFAULT true,ADD feishu_group_chat_enabled boolean,
        ADD group_requires_at boolean DEFAULT true,ADD group_read_enabled boolean DEFAULT true`);
    let modelCalls = 0;
    const ingress = createPostgresImIngress({ pool, secretKey, attachments: { mode: 'text-only' }, supportedPlatforms: () => ['telegram'],
      preflight: async () => { throw new Error('可信准入消息不能重跑控制分流'); },
      model: { async accessVersion() { modelCalls++; return 'a'.repeat(64); } }, memoryEnabled: async () => true, notify: async () => {}, diagnose() {} });
    const passive = { ...payload, chat_type: 'group', chat_id: 'synthetic-passive-room', bot_mentioned: false,
      message_id: 'passive-native', platform_message_id: 'passive-native', _node_stream_event_id: '999999-0' };
    assert.equal(await ingress.prepareAdmitted(binding, passive, '1700000000001-0', new AbortController().signal), false);
    await pool.query('UPDATE user_bots SET group_requires_at=false');
    assert.equal(await ingress.prepareAdmitted(binding, passive, '1700000000002-0', new AbortController().signal), false);
    assert.equal(await ingress.prepareAdmitted(binding, { ...passive, _pending_ask_resume: true }, '1700000000003-0', new AbortController().signal), false);
    const passiveRows = (await pool.query(`SELECT m.id,m.run_id,r.state,r.sealed_payload FROM conversation_messages m
      JOIN gugu_im_inbound_receipts r ON r.message_id=m.id JOIN conversation_sessions s ON s.id=m.session_id WHERE s.chat_id='synthetic-passive-room'`)).rows;
    assert.equal(passiveRows.length, 1); assert.equal(passiveRows[0].run_id, null); assert.equal(passiveRows[0].state, 'passive');
    const { createImInboundEnvelope } = await import('../../../../src/modules/im/gateway/inbound/envelope.js');
    assert.equal(createImInboundEnvelope(secretKey).open(binding, passiveRows[0].sealed_payload)._node_stream_event_id, '1700000000001-0');
    assert.equal(await ingress.prepareAdmitted(binding, { ...passive, message_id: 'fresh-native', platform_message_id: 'fresh-native' }, '1700000000004-0', new AbortController().signal), true);
    assert.equal(modelCalls, 0);
    const legacyGroup = { ...payload, chat_type: 'group', chat_id: 'synthetic-legacy-room',
      message_id: 'legacy-room-new', platform_message_id: 'legacy-room-new' };
    const legacy = (await pool.query<{ id: number }>(`INSERT INTO conversation_sessions
      (user_id,source,bot_id,chat_id,chat_type,last_message_seq,updated_at)
      VALUES($1,'telegram','71',$2,NULL,1,clock_timestamp()) RETURNING id`, [owner, legacyGroup.chat_id])).rows[0]!;
    await pool.query(`INSERT INTO conversation_messages(session_id,conversation_seq,role,content)
      VALUES($1,1,'user','旧群消息')`, [legacy.id]);
    const otherBot = (await pool.query<{ id: number }>(`INSERT INTO conversation_sessions
      (user_id,source,bot_id,chat_id,chat_type,last_message_seq,updated_at)
      VALUES($1,'telegram','73',$2,'group',0,clock_timestamp()) RETURNING id`, [owner, legacyGroup.chat_id])).rows[0]!;
    const resumed = await store.persist(binding, legacyGroup, {
      eventId: 'legacy-room-event', mode: 'dispatch', sessionId: otherBot.id, onDispatch: dispatch,
    });
    assert.equal(resumed?.sessionId, legacy.id);
    assert.equal(resumed?.isNewSession, false);
    assert.equal((await pool.query('SELECT chat_type FROM conversation_sessions WHERE id=$1', [legacy.id])).rows[0].chat_type, 'group');
    assert.deepEqual((await pool.query('SELECT conversation_seq::int AS seq FROM conversation_messages WHERE session_id=$1 ORDER BY conversation_seq', [legacy.id])).rows, [{ seq: 1 }, { seq: 2 }]);
    await pool.query('UPDATE user_bots SET enabled=false'); await assert.rejects(store.readRoute({ ownerId: owner, sessionId: String(a!.sessionId), runId: a!.runId! }), ImConversationError);
    await assert.rejects(store.readRoute({ ownerId: owner, sessionId: String(segment.anchors[0]!.sessionId), runId: segment.runId! }), ImConversationError);
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
