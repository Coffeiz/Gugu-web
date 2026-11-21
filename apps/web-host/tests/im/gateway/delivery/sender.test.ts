import { feishuPrivateReply, telegramPrivateReply } from '../../../../../../packages/gateway/tests/fixtures/private-replies.js'
import { qqPrivateReply } from '../../../../../../packages/gateway/tests/fixtures/qq-private-reply.js'
import { wechatPrivateReply } from '../../../../../../packages/gateway/tests/fixtures/wechat-private-reply.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool } from 'pg'
import { resolveImActor } from '@gugu/core/im/access'
import { createPostgresFileReadOperations } from '../../../../src/modules/files/browse.js'
import { createImRunSender } from '../../../../src/modules/im/gateway/delivery/reply.js'
import { imAcceptedEvidence } from '../../../../src/modules/im/gateway/agent/evidence.js'
import { context, receipt, platform, temporary, fakeDatabase, deliveryOutcome, owner } from '../run-sender.fixtures.js'

// 控制服务替身在这些纯出站用例中不得执行；真实prompt授权组合另由controls-postgres回归覆盖。
const controls = { async authorizeNativeTarget(): Promise<boolean> { assert.fail('普通文本不能读取交互授权') } }
const nativeInteraction = async () => 'unknown' as const
const body = (value: unknown) => JSON.parse(typeof value === 'string' ? value : Buffer.from(value as Uint8Array).toString())
function resources(c: ReturnType<typeof context>, pool: Pool, root: string, wire: ReturnType<typeof platform>, authorize = async () => true) {
  return { ...c, pool, storageRoot: root, messageIds: ['11'], files: createPostgresFileReadOperations(pool, null, root),
    sender: () => wire.sender, authorize, controls, nativeInteraction, publicAppUrl: 'https://app.example' }
}

test('四平台真实sender保留原生回复目标、微信冻结context_token；权限撤销不再HTTP', async () => temporary(async root => {
  for (const kind of ['telegram', 'feishu', 'qq', 'wechat'] as const) {
    const base = context(kind)
    const fixture = { wechat: wechatPrivateReply, qq: qqPrivateReply, feishu: feishuPrivateReply, telegram: telegramPrivateReply }[kind]
    const scope = { ...base.scope, platformUserId: fixture.recipient }
    const originalId = 'originalMessageId' in fixture ? fixture.originalMessageId : undefined
    const c = {
      ...base, scope,
      actor: resolveImActor({ ...scope, botMentioned: true, mentionsOtherBot: false }, () => ({ role: 'owner', allowedToolNames: null })),
      payload: { ...base.payload, platform_user_id: scope.platformUserId,
        message_id: originalId ?? wechatPrivateReply.contextToken,
        context_token: kind === 'wechat' ? wechatPrivateReply.contextToken : base.payload.context_token,
        ...(originalId ? { platform_message_id: originalId } : {}),
      },
    }
    const db = fakeDatabase(c), wire = platform(kind, undefined, true)
    let allowed = true
    const pool = { async query(sql: string, args: unknown[]) {
      if (sql.includes('SELECT group_message_format')) return { rows: [{ group_message_format: null, private_message_format: null }] }
      return db.pool.query(sql, args)
    } } as unknown as Pool
    try {
      const sender = await createImRunSender(resources(c, pool, root, wire, async () => allowed))
      const result = await sender.text({ identity: c.identity, deliveryId: fixture.deliveryId, text: fixture.text })
      assert.equal(deliveryOutcome(result), 'accepted', kind)
      assert.ok(typeof result === 'object' && result.evidence)
      const evidence = result.evidence as Record<string, unknown>
      assert.equal(evidence.text, '合成输出'); assert.equal(evidence.contentHash, createHash('sha256').update('合成输出').digest('hex'))
      assert.deepEqual(evidence.sourceEventIds, ['1791000000000-1'])
      assert.deepEqual(evidence.sourceMessageIds, originalId ? [originalId] : [])
      assert.deepEqual(evidence.coverage, { nativeMessageIds: kind !== 'wechat', sourceEventIds: true })
      assert.deepEqual(evidence.platformMessageIds, kind === 'telegram' ? ['11'] : kind === 'feishu' ? ['om_synthetic'] : kind === 'qq' ? ['synthetic-message'] : [])
      assert.equal(evidence.recipient, c.scope.platformUserId)
      assert.ok(!JSON.stringify(evidence).includes(c.payload.context_token))
      const request = wire.requests.at(-1)!, sent = body(request.body)
      if (kind === 'telegram') { assert.equal(sent.chat_id, telegramPrivateReply.recipient); assert.equal(sent.reply_to_message_id, Number(telegramPrivateReply.originalMessageId)); assert.equal(sent.text, telegramPrivateReply.text) }
      if (kind === 'feishu') { assert.equal(sent.receive_id, feishuPrivateReply.recipient); assert.equal(sent.msg_type, 'interactive'); assert.equal(sent.reply_to_message_id, undefined); assert.ok(sent.content.includes(feishuPrivateReply.text)) }
      if (kind === 'qq') { assert.equal(sent.msg_id, qqPrivateReply.originalMessageId); assert.equal(sent.msg_type, 2); assert.equal(new URL(request.url).pathname, `/v2/users/${qqPrivateReply.recipient}/messages`); assert.equal(sent.markdown.content, qqPrivateReply.text) }
      if (kind === 'wechat') {
        assert.equal(sent.msg.to_user_id, wechatPrivateReply.recipient)
        assert.equal(sent.msg.context_token, wechatPrivateReply.contextToken)
        assert.equal(sent.msg.item_list[0].text_item.text, wechatPrivateReply.text)
      }
      const before = wire.requests.length; allowed = false
      assert.equal(await sender.text({ identity: c.identity, deliveryId: 'revoked', text: '不能发送' }), 'rejected')
      assert.equal(wire.requests.length, before)
    } finally { await wire.close() }
  }
}))

test('QQ可信群格式默认compat、显式markdown可用；配置变更冻结旧Run且坏非空配置拒绝装配', async () => temporary(async root => {
  for (const initial of [null, 'markdown', 'compat', '', 'invalid'] as const) {
    const base = context('qq'), scope = { ...base.scope, chatType: 'group' as const, chatId: 'synthetic_group' }
    const c = { ...base, scope, actor: resolveImActor({ ...scope, botMentioned: true, mentionsOtherBot: false }, () => ({ role: 'owner', allowedToolNames: null })),
      payload: { ...base.payload, chat_type: 'group' as const, chat_id: scope.chatId } }
    const db = fakeDatabase(c), wire = platform('qq', undefined, true); let format: unknown = initial
    const pool = { async query(sql: string, args: unknown[]) { return sql.includes('SELECT group_message_format')
      ? { rows: [{ group_message_format: format, private_message_format: null }] } : db.pool.query(sql, args) } } as unknown as Pool
    try {
      const options = resources(c, pool, root, wire)
      if (initial === '' || initial === 'invalid') { await assert.rejects(createImRunSender(options), { message: 'IM 运行回复装配不可用' }); assert.equal(wire.requests.length, 0); continue }
      const sender = await createImRunSender(options)
      assert.equal(deliveryOutcome(await sender.text({ identity: c.identity, deliveryId: 'group', text: '群输出' })), 'accepted')
      const sent = body(wire.requests.at(-1)!.body)
      assert.equal(sent.msg_type, initial === 'markdown' ? 2 : 0); assert.equal(sent.msg_id, '31')
      assert.equal(String(sent.content ?? sent.markdown.content), '群输出')
      const before = wire.requests.length; format = initial === 'markdown' ? 'compat' : 'markdown'
      assert.equal(await sender.text({ identity: c.identity, deliveryId: 'changed', text: '旧格式不得继续' }), 'rejected')
      assert.equal(wire.requests.length, before)
    } finally { await wire.close() }
  }
}))

test('有凭据查询参数、fragment、userinfo的网页base装配失败且不出站', async () => temporary(async root => {
  const c = context(), db = fakeDatabase(c), wire = platform('telegram')
  try {
    for (const publicAppUrl of ['https://app.example?access_token=synthetic-private', 'https://app.example/#synthetic-private', 'https://user:synthetic-private@app.example', 'javascript:synthetic-private', 'invalid-synthetic-private']) {
      await assert.rejects(createImRunSender({ ...resources(c, db.pool, root, wire), publicAppUrl }), error => {
        assert.ok(error instanceof Error); assert.equal(error.message, 'IM 运行回复装配不可用'); assert.equal(error.cause, undefined)
        assert.doesNotMatch(JSON.stringify(error), /synthetic-private/); return true
      })
      assert.equal(wire.requests.length, 0)
    }
  } finally { await wire.close() }
}))

test('同scope密文错置、物理speaker/nativeID变化和旧TG空native锚点均在发送前拒绝', async () => temporary(async root => {
  for (const fault of ['speaker', 'native', 'null', 'cipher', 'fingerprint'] as const) {
    const c = context(), wire = platform('telegram'), stored = receipt(c)
    const wrong = context(); wrong.payload.text = '同scope另一事件'; wrong.payload.message_id = '99'; wrong.payload.platform_message_id = '99'
    const row = { id: '11', conversation_seq: '3', ...stored,
      ...(fault === 'speaker' ? { platform_user_id: '303' } : fault === 'native' ? { im_platform_message_id: '99' } : fault === 'null' ? { im_platform_message_id: null }
        : fault === 'cipher' ? { sealed_payload: receipt(wrong).sealed_payload } : { fingerprint: '0'.repeat(64) }) }
    const pool = { async query() { return { rows: [row] } } } as unknown as Pool
    try { await assert.rejects(createImRunSender(resources(c, pool, root, wire)), { message: 'IM 运行投递范围不可用' }); assert.equal(wire.requests.length, 0) }
    finally { await wire.close() }
  }
}))

test('原生交互未知不再降级发文字，避免平台已接受时重复回复', async () => temporary(async root => {
  const c = context(), db = fakeDatabase(c), wire = platform('telegram')
  try {
    const sender = await createImRunSender(resources(c, db.pool, root, wire))
    assert.equal(await sender.interaction({ identity: c.identity, deliveryId: 'prompt', event: { identity: c.identity, type: 'interaction_required',
      id: 'synthetic-event', sequence: 1, round: 0, payload: { interactionId: 'synthetic-prompt', toolCallId: 'call' } } }), 'unknown')
    assert.equal(wire.requests.length, 0)
  } finally { await wire.close() }
}))

test('旧收据缺少原始队列ID仍能投递，但证据明确不完整且不拿message ID猜stream ID', async () => temporary(async root => {
  const c = context('wechat'); delete (c.payload as Record<string, unknown>)._node_stream_event_id
  const db = fakeDatabase(c), wire = platform('wechat')
  try {
    const sender = await createImRunSender(resources(c, db.pool, root, wire))
    const result = await sender.text({ identity: c.identity, deliveryId: 'legacy-source', text: '合成旧消息回复' })
    assert.ok(typeof result === 'object' && result.evidence)
    const evidence = result.evidence as Record<string, unknown>
    assert.deepEqual(evidence.coverage, { nativeMessageIds: false, sourceEventIds: false })
    assert.deepEqual(evidence.sourceEventIds, []); assert.deepEqual(evidence.sourceMessageIds, []); assert.deepEqual(evidence.platformMessageIds, [])
    assert.doesNotMatch(JSON.stringify(evidence), /synthetic-reply-context/)
  } finally { await wire.close() }
}))

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('超出ledger UTF8正文预算仅保留完整hash，不截断正文或丢失真实成功ID', () => {
  for (const text of ['a'.repeat(48000), '合'.repeat(16000), '合'.repeat(16001)]) {
    const result = imAcceptedEvidence({ scope: context().scope, recipient: '202', kind: 'text', text,
      source: { sourceEventIds: ['1791000000000-1'], sourceMessageIds: ['31'], sourceEventIdsComplete: true },
      receipt: { outcome: 'accepted', platformMessageIds: ['11'] } })
    assert.ok(typeof result === 'object' && result.evidence)
    const evidence = result.evidence as Record<string, unknown>
    assert.equal(evidence.text, Buffer.byteLength(text) <= 48000 ? text : undefined)
    assert.equal(evidence.contentHash, createHash('sha256').update(text).digest('hex'))
    assert.deepEqual(evidence.platformMessageIds, ['11'])
  }
})
test('真实隔离PG证明→四平台真实文本HTTP，批次按业务顺序核对全部锚点并抵抗密封收据错置', {
  skip: !pgUrl && '需显式隔离PG；平台HTTP与QQ序号为可控替身', timeout: 30000,
}, async () => temporary(async root => {
  const { Pool } = await import('pg'), schema = `im_sender_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: pgUrl })
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
    await pool.query(`CREATE TABLE conversation_sessions(id integer,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text);
      CREATE TABLE conversation_messages(id integer,session_id integer,run_id text,role text,chat_type text,platform_user_id text,conversation_seq integer,im_platform_message_id text);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,state text,platform text,bot_id text,chat_type text,scope_hash text,event_hash text,fingerprint text,sealed_payload jsonb);
      CREATE TABLE user_bots(id integer,user_id uuid,platform text,enabled boolean,group_message_format text,private_message_format text,private_streaming_enabled boolean NOT NULL DEFAULT false)`)
    await pool.query("INSERT INTO conversation_sessions VALUES(91,$1,'web',NULL,NULL,NULL)", [owner])
    for (const kind of ['telegram', 'feishu', 'qq', 'wechat'] as const) {
      const c = context(kind), wire = platform(kind, undefined, true), r = receipt(c)
      await pool.query('TRUNCATE conversation_messages,gugu_im_inbound_receipts,user_bots')
      await pool.query('INSERT INTO user_bots(id,user_id,platform,enabled) VALUES(91,$1,$2,true)', [owner, kind])
      await pool.query("INSERT INTO conversation_messages VALUES(11,91,$1,'user','c2c',$2,3,$3)", [c.identity.runId, c.scope.platformUserId, r.im_platform_message_id])
      await pool.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,91,11,$2,'dispatched',$3,'91','c2c',$4,$5,$6,$7)", [owner, c.identity.runId, kind, r.scope_hash, r.event_hash, r.fingerprint, r.sealed_payload])
      try {
        const sender = await createImRunSender(resources(c, pool, root, wire))
        assert.equal(deliveryOutcome(await sender.text({ identity: c.identity, deliveryId: kind, text: '真实PG授权输出' })), 'accepted', kind)
        if (kind === 'wechat') {
          const count = wire.requests.length, changed = { ...c, payload: { ...c.payload, context_token: 'another-private-context', message_id: 'another-private-context' } }
          await pool.query('UPDATE gugu_im_inbound_receipts SET sealed_payload=$1', [receipt(changed).sealed_payload])
          assert.equal(await sender.text({ identity: c.identity, deliveryId: 'wrong-token', text: '不得借新token' }), 'rejected'); assert.equal(wire.requests.length, count)
        }
      } finally { await wire.close() }
    }
    const c = context(), first = { ...c, payload: { ...c.payload, message_id: '30', platform_message_id: '30', _node_stream_event_id: '1791000000000-0', text: '第一条' } }, wire = platform('telegram')
    await pool.query('TRUNCATE conversation_messages,gugu_im_inbound_receipts')
    for (const [id, seq, fact] of [[99, 2, first], [11, 3, c]] as const) {
      const r = receipt(fact)
      await pool.query("INSERT INTO conversation_messages VALUES($1,91,$2,'user','c2c',$3,$4,$5)", [id, c.identity.runId, c.scope.platformUserId, seq, r.im_platform_message_id])
      await pool.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,91,$2,$3,'dispatched','telegram','91','c2c',$4,$5,$6,$7)", [owner, id, c.identity.runId, r.scope_hash, r.event_hash, r.fingerprint, r.sealed_payload])
    }
    try {
      const aggregate = { ...c, payload: { ...c.payload, _batch_messages: [first.payload, c.payload] } }
      const sender = await createImRunSender({ ...resources(aggregate, pool, root, wire), messageIds: ['99', '11'] })
      assert.equal(deliveryOutcome(await sender.text({ identity: c.identity, deliveryId: 'batch', text: '批次输出' })), 'accepted')
      assert.equal(body(wire.requests.at(-1)!.body).reply_to_message_id, 31)
      const count = wire.requests.length
      await pool.query('UPDATE gugu_im_inbound_receipts SET sealed_payload=$1 WHERE message_id=99', [receipt(c).sealed_payload])
      assert.equal(await sender.text({ identity: c.identity, deliveryId: 'swapped', text: '不可借用' }), 'rejected'); assert.equal(wire.requests.length, count)
    } finally { await wire.close() }
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() }
}))
