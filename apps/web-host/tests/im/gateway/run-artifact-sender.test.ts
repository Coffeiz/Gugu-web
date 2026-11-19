import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { Pool } from 'pg'
import { resolveImActor } from '@gugu/core/im/access'
import type { PortableValue } from '@gugu/core/agent'
import { aggregateImInboundPayloads } from '@gugu/core/im/inbound-batch'
import { createPostgresFileReadOperations } from '../../../src/modules/files/browse.js'
import { createImRunArtifactSender } from '../../../src/modules/im/gateway/delivery/artifacts.js'
import { imAttachmentScopeKey, type ImAttachmentScope } from '../../../src/modules/im/gateway/inbound/attachments.js'
import { context, receipt, platform, temporary, fakeDatabase, deliveryOutcome, owner, other, data, stored } from './run-sender.fixtures.js'
test('真实本地附件→真实Telegram上传，拒绝root路径/歧义引用/跨Run并忽略模型伪造文件名', async () => temporary(async root => {
  const db = fakeDatabase(), p = platform('telegram'), c = context()
  const send = createImRunArtifactSender({ ...c, pool: db.pool, storageRoot: root, messageIds: ['11'], files: createPostgresFileReadOperations(db.pool, null, root),
    sender: () => p.sender, authorize: async () => true })
  try {
    const result = await send({ identity: c.identity, deliveryId: 'a', artifact: { attach_id: 'attachment', name: '不可信模型名称' } })
    assert.equal(deliveryOutcome(result), 'accepted')
    assert.ok(typeof result === 'object' && result.evidence)
    const evidence = result.evidence as Record<string, unknown>
    assert.equal(evidence.kind, 'artifact'); assert.equal(evidence.contentHash, createHash('sha256').update(data).digest('hex'))
    assert.deepEqual(evidence.platformMessageIds, ['11']); assert.deepEqual(evidence.sourceMessageIds, ['31'])
    assert.deepEqual(evidence.sourceEventIds, ['1791000000000-1']); assert.equal(evidence.text, undefined)
    assert.equal(p.requests.length, 1)
    assert.match(Buffer.from(p.requests[0]!.body as Uint8Array).toString(), /合成报告\.txt/)
    assert.doesNotMatch(Buffer.from(p.requests[0]!.body as Uint8Array).toString(), /不可信模型名称/)
    const invalidArtifacts: PortableValue[] = [{ rootId: 'untrusted-host-root', relativePath: '../../private' }, { attach_id: 'attachment', file_id: 1 }, { file_id: 1, id: 2 }, { file_id: 0 }]
    for (const artifact of invalidArtifacts)
      assert.equal(await send({ identity: c.identity, deliveryId: 'bad', artifact }), 'rejected')
    assert.equal(await send({ identity: { ...c.identity, runId: 'another-run' }, deliveryId: 'bad', artifact: { attach_id: 'attachment' } }), 'rejected')
    assert.equal(p.requests.length, 1)
  } finally { await p.close() }
}))

test('晚于当前Run水位、跨scope/owner路径、权限撤销及member读取owner兼容file均在网络前拒绝', async () => temporary(async root => {
  for (const change of ['later', 'wrongScope', 'otherOwner', 'revoke', 'member'] as const) {
    const db = fakeDatabase(), c = context('telegram', change === 'member'), p = platform('telegram')
    if (change === 'later') db.later(); if (change === 'wrongScope') db.wrongScope(); if (change === 'otherOwner') db.otherOwner()
    let reads = 0
    const send = createImRunArtifactSender({ ...c, pool: db.pool, storageRoot: root, messageIds: ['11'], sender: () => p.sender,
      authorize: async () => change !== 'revoke', files: { async openContent() { reads++; assert.fail('受限输入不能读owner文件') }, async getFile() { reads++; assert.fail('不能探测owner文件') } } })
    try { assert.equal(await send({ identity: c.identity, deliveryId: 'bad', artifact: change === 'member' ? { file_id: 1 } : { attach_id: 'attachment' } }), 'rejected');
      assert.equal(p.requests.length, 0); assert.equal(reads, 0) } finally { await p.close() }
  }
}))

test('四平台制品透传真实调用者取消：上传中止后无后续消息HTTP，也不把取消异常/凭据公开',async()=>temporary(async root=>{
 for(const kind of ['telegram','feishu','qq','wechat'] as const){
  const controller=new AbortController(),c=context(kind),db=fakeDatabase(c)
  const p=platform(kind,request=>{
   const path=new URL(request.url).pathname
   if(kind==='telegram'||kind==='feishu'&&path.endsWith('/files')||kind==='qq'&&path.endsWith('/upload_prepare')||kind==='wechat'&&path.endsWith('/getuploadurl'))controller.abort()
  })
  const send=createImRunArtifactSender({...c,pool:db.pool,storageRoot:root,messageIds:['11'],files:createPostgresFileReadOperations(db.pool,null,root),sender:()=>p.sender,authorize:async()=>true})
  try{
   const result=await send({identity:c.identity,deliveryId:'cancelled-upload',artifact:{attach_id:'attachment'}},controller.signal)
   assert.notEqual(deliveryOutcome(result),'accepted',kind)
   assert.ok(controller.signal.aborted)
   assert.equal(p.requests.filter(r=>/\/(messages|sendmessage|upload_part_finish)$/.test(new URL(r.url).pathname)).length,0,kind)
   assert.doesNotMatch(JSON.stringify(result),/synthetic-reply-context|private|stack/u)
  }finally{await p.close()}
 }
}))

test('飞书/QQ/微信上传阶段撤权后不发消息或后续分片确认，已启动流程不盲重传', async () => temporary(async root => {
  for (const [kind, phase] of [['feishu', 'upload'], ['qq', 'prepare'], ['qq', 'upload'], ['wechat', 'prepare'], ['wechat', 'upload']] as const) {
    const c = context(kind), db = fakeDatabase()
    // 此用例仅PG查询为受控替身；底层sender/client/media和本地文件读取均为实际实现。
    const pool = { async query(sql: string) { if (sql.includes('gugu_im_inbound_receipts')) return { rows: [{ id: '11', conversation_seq: '3', ...receipt(c) }] }
      return { rows: [{ name: '合成报告', ext: 'txt', mime: 'text/plain', size: data.length, storage_key: stored,
        extra: { im_ingress_scope: imAttachmentScopeKey(c.scope) }, conversation_seq: 3 }] }
    } } as unknown as Pool
    let allowed = true
    const p = platform(kind, request => {
      const path = new URL(request.url).pathname
      if (kind === 'feishu' && path.endsWith('/files') || kind === 'qq' && (phase === 'prepare' ? path.endsWith('/upload_prepare') : request.method === 'PUT')
        || kind === 'wechat' && (phase === 'prepare' ? path.endsWith('/getuploadurl') : path === '/c2c/upload')) allowed = false
    })
    const send = createImRunArtifactSender({ ...c, pool, storageRoot: root, messageIds: ['11'], files: createPostgresFileReadOperations(db.pool, null, root),
      sender: () => p.sender, authorize: async () => allowed })
    try {
      const result = await send({ identity: c.identity, deliveryId: 'withdraw', artifact: { attach_id: 'attachment' } })
      assert.notEqual(deliveryOutcome(result), 'accepted', kind)
      assert.equal(p.requests.filter(request => /\/(messages|sendmessage)$/.test(new URL(request.url).pathname)).length, 0, kind)
      if (kind === 'qq') assert.equal(p.requests.filter(request => request.url.endsWith('/upload_part_finish')).length, 0)
      if (phase === 'prepare') assert.equal(p.requests.filter(request => request.method === 'PUT' || request.url.includes('/c2c/upload')).length, 0)
    } finally { await p.close() }
  }
}))

test('Telegram制品在真实sender队列中等待后撤权，出队不再发送文件HTTP', async () => temporary(async root => {
  let entered!: () => void, release!: () => void, queued!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve }), blocked = new Promise<void>(resolve => { release = resolve }), queuedPromise = new Promise<void>(resolve => { queued = resolve })
  const p = platform('telegram', async request => { if (request.url.endsWith('/sendMessage')) { entered(); await blocked } })
  if (p.sender.platform !== 'telegram') assert.fail('测试平台错误')
  const actualFile = p.sender.sender.file
  // 只观察公共调用到达队列；真正排队、HTTP与guard仍由实际sender执行。
  p.sender.sender.file = (...args) => { queued(); return actualFile(...args) }
  const first = p.sender.sender.text({ chatId: '999', chatType: 'c2c' }, '合成队列前置消息')
  let allowed = true
  try {
    await enteredPromise
    const c = context(), db = fakeDatabase(), send = createImRunArtifactSender({ ...c, pool: db.pool, storageRoot: root, messageIds: ['11'],
      files: createPostgresFileReadOperations(db.pool, null, root), sender: () => p.sender, authorize: async () => allowed })
    const pending = send({ identity: c.identity, deliveryId: 'queued', artifact: { attach_id: 'attachment' } })
    await queuedPromise; allowed = false; release(); await first
    assert.notEqual(deliveryOutcome(await pending), 'accepted')
    assert.equal(p.requests.length, 1, '只有已发送的前置文本，不能发排队制品')
  } finally { release(); await first; await p.close() }
}))

test('未知发送错误不重试，不公开源文件内容/路径；本地文件失踪在平台请求前失败', async () => temporary(async root => {
  const db = fakeDatabase(), c = context(), p = platform('telegram', () => { throw new Error('synthetic-private-transport') })
  const send = createImRunArtifactSender({ ...c, pool: db.pool, storageRoot: root, messageIds: ['11'], files: createPostgresFileReadOperations(db.pool, null, root),
    sender: () => p.sender, authorize: async () => true })
  try {
    assert.equal(await send({ identity: c.identity, deliveryId: 'unknown', artifact: { attach_id: 'attachment' } }), 'unknown')
    assert.equal(p.requests.length, 1)
    await rm(join(root, stored))
    assert.equal(await send({ identity: c.identity, deliveryId: 'missing', artifact: { attach_id: 'attachment' } }), 'rejected')
    assert.equal(p.requests.length, 1)
  } finally { await p.close() }
}))

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('真实隔离PG/FS→四平台真实sender/client协议，旧file_id只读owned库且Run水位与软删除可复核', {
  skip: !pgUrl && '需显式隔离PG；平台仅HTTP传输为可控替身，无真实账号或付费Provider', timeout: 30000,
}, async () => temporary(async root => {
  const { Pool } = await import('pg'), schema = `im_artifact_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: pgUrl })
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}`, max: 3 })
    await pool.query(`CREATE TABLE conversation_sessions(id integer,user_id uuid,source text,bot_id text,chat_type text,chat_id text);
      CREATE TABLE conversation_messages(id integer,session_id integer,run_id text,role text,chat_type text,platform_user_id text,conversation_seq integer,im_platform_message_id text);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,state text,platform text,bot_id text,chat_type text,scope_hash text,event_hash text,fingerprint text,sealed_payload jsonb);
      CREATE TABLE chat_attachments(attach_id text,user_id uuid,message_id integer,state text,platform text,extra jsonb,storage_key text,name text,ext text,mime text,size bigint);
      CREATE TABLE projects(id integer,user_id uuid,name text,color text); CREATE TABLE folders(id integer,user_id uuid,name text);
      CREATE TABLE files(id integer,user_id uuid,display_name text,ext text,space text,workspace_directory_id integer,storage_key text,project_id integer,stage_name text,
        folder_id integer,mind_map_id integer,size text,size_bytes bigint,mime_type text,created_at timestamptz,deleted_at timestamptz,img_width integer,img_height integer,version integer)`)
    await pool.query("INSERT INTO conversation_sessions VALUES(91,$1,'web',NULL,NULL,NULL)", [owner])
    await pool.query("INSERT INTO files(id,user_id,display_name,ext,storage_key,size_bytes,mime_type,created_at,version) VALUES(1,$1,'兼容旧文件','txt',$2,$3,'text/plain',clock_timestamp(),1)", [owner, stored, data.length])
    const db = pool, files = createPostgresFileReadOperations(db, null, root)
    for (const kind of ['telegram', 'feishu', 'qq', 'wechat'] as const) {
      const c = context(kind), p = platform(kind)
      await db.query('DELETE FROM chat_attachments'); await db.query('DELETE FROM gugu_im_inbound_receipts'); await db.query('DELETE FROM conversation_messages')
      const proof = receipt(c)
      await db.query("INSERT INTO conversation_messages VALUES(11,91,$1,'user','c2c',$2,3,$3),(12,91,'later','user','c2c',$2,4,'later')", [c.identity.runId, c.scope.platformUserId, proof.im_platform_message_id])
      await db.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,91,11,$2,'dispatched',$3,'91','c2c',$4,$5,$6,$7)", [owner, c.identity.runId, kind, proof.scope_hash, proof.event_hash, proof.fingerprint, proof.sealed_payload])
      await db.query("INSERT INTO chat_attachments VALUES('attachment',$1,11,'attached',$2,$3,$4,'合成报告','txt','text/plain',$5)", [owner, kind, { im_ingress_scope: imAttachmentScopeKey(c.scope) }, stored, data.length])
      const send = createImRunArtifactSender({ ...c, pool: db, files, storageRoot: root, messageIds: ['11'], sender: () => p.sender, authorize: async () => true })
      try {
        assert.equal(deliveryOutcome(await send({ identity: c.identity, deliveryId: kind, artifact: { attach_id: 'attachment' } })), 'accepted', kind)
        const count = p.requests.length
        await db.query('UPDATE chat_attachments SET message_id=12')
        assert.equal(await send({ identity: c.identity, deliveryId: 'later', artifact: { attach_id: 'attachment' } }), 'rejected', kind)
        assert.equal(p.requests.length, count)
        assert.equal(deliveryOutcome(await send({ identity: c.identity, deliveryId: 'legacy', artifact: { file_id: 1 } })), 'accepted', `${kind} legacy`)
        await db.query('UPDATE files SET deleted_at=clock_timestamp()')
        const before = p.requests.length
        assert.equal(await send({ identity: c.identity, deliveryId: 'deleted', artifact: { file_id: 1 } }), 'rejected')
        assert.equal(p.requests.length, before); await db.query('UPDATE files SET deleted_at=NULL')
        if (kind === 'telegram') {
          await db.query('UPDATE files SET user_id=$1', [other])
          assert.equal(await send({ identity: c.identity, deliveryId: 'other-owner', artifact: { file_id: 1 } }), 'rejected')
          assert.equal(p.requests.length, before); await db.query('UPDATE files SET user_id=$1', [owner])
          const groupScope: ImAttachmentScope = { ...c.scope, chatType: 'group', chatId: '-777' }
          const groupActor = resolveImActor({ ...groupScope, botMentioned: true, mentionsOtherBot: false }, () => ({ role: 'member', allowedToolNames: ['send_file', 'read_file'] }))
          await db.query("UPDATE conversation_sessions SET source='telegram',bot_id='91',chat_type='group',chat_id='-777'")
          await db.query("UPDATE conversation_messages SET chat_type='group'")
          await db.query("UPDATE gugu_im_inbound_receipts SET chat_type='group'")
          await db.query('UPDATE chat_attachments SET message_id=11,extra=$1', [{ im_ingress_scope: imAttachmentScopeKey(groupScope) }])
          const groupC = { ...c, actor: groupActor, scope: groupScope, payload: { ...c.payload, chat_type: 'group' as const, chat_id: '-777' } }, groupProof = receipt(groupC)
          await db.query('UPDATE gugu_im_inbound_receipts SET scope_hash=$1,event_hash=$2,fingerprint=$3,sealed_payload=$4', [groupProof.scope_hash, groupProof.event_hash, groupProof.fingerprint, groupProof.sealed_payload])
          const groupSend = createImRunArtifactSender({ ...groupC,
            pool: db, files, storageRoot: root, messageIds: ['11'], sender: () => p.sender, authorize: async () => true })
          assert.equal(deliveryOutcome(await groupSend({ identity: c.identity, deliveryId: 'group', artifact: { attach_id: 'attachment' } })), 'accepted')
          const groupCount = p.requests.length
          await db.query("UPDATE conversation_sessions SET bot_id='92'")
          assert.equal(await groupSend({ identity: c.identity, deliveryId: 'wrong-bot', artifact: { attach_id: 'attachment' } }), 'rejected')
          assert.equal(p.requests.length, groupCount)
          await db.query("UPDATE conversation_sessions SET source='web',bot_id=NULL,chat_type=NULL,chat_id=NULL")
        }
        if (kind === 'feishu') {
          const last = { ...c.payload, message_id: '32', platform_message_id: '32', chat_id: 'oc_synthetic_batch_last', text: '合成第二条消息', _node_stream_event_id: '1791000000001-1' }
          const lastProof = receipt({ ...c, payload: last })
          await db.query("UPDATE conversation_messages SET run_id=$1,im_platform_message_id='32' WHERE id=12", [c.identity.runId])
          await db.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,91,12,$2,'dispatched','feishu','91','c2c',$3,$4,$5,$6)", [owner, c.identity.runId, lastProof.scope_hash, lastProof.event_hash, lastProof.fingerprint, lastProof.sealed_payload])
          await db.query('UPDATE chat_attachments SET message_id=11')
          const aggregate = aggregateImInboundPayloads([
            { eventId: '1791000000000-1', payload: c.payload, anchor: { messageId: 11, conversationSeq: 3 } },
            { eventId: '1791000000001-1', payload: last, anchor: { messageId: 12, conversationSeq: 4 } },
          ])
          assert.equal(aggregate.chat_id, null, '正式私聊聚合最外路由不携带原生chat ID')
          const batchSender = (payload: Record<string, unknown>) => createImRunArtifactSender({ ...c, payload, pool: db, files, storageRoot: root, messageIds: ['11', '12'], sender: () => p.sender, authorize: async () => true })
          const accepted = await batchSender(aggregate)({ identity: c.identity, deliveryId: 'batch-feishu', artifact: { attach_id: 'attachment' } })
          assert.equal(deliveryOutcome(accepted), 'accepted')
          const actualMessage = p.requests.filter(r => new URL(r.url).pathname.endsWith('/messages')).at(-1)!
          assert.equal(JSON.parse(Buffer.from(actualMessage.body as Uint8Array).toString()).receive_id, last.chat_id)
          assert.ok(typeof accepted === 'object' && accepted.evidence)
          assert.deepEqual((accepted.evidence as Record<string, unknown>).sourceMessageIds, ['31', '32'])
          assert.equal((accepted.evidence as Record<string, unknown>).recipient, last.chat_id)
          const beforeTamper = p.requests.length
          for (const index of [0, 1]) {
            const tampered = structuredClone(aggregate)
            ;(tampered._batch_messages as Array<Record<string, unknown>>)[index]!.chat_id = 'oc_untrusted_target'
            assert.equal(await batchSender(tampered)({ identity: c.identity, deliveryId: `tampered-chat-${index}`, artifact: { attach_id: 'attachment' } }), 'rejected')
            assert.equal(p.requests.length, beforeTamper, '整个批次逐锚验证之前不能上传或发送')
          }
          const groupScope: ImAttachmentScope = { ...c.scope, chatType: 'group', chatId: 'oc_synthetic_group' }
          const groupActor = resolveImActor({ ...groupScope, botMentioned: true, mentionsOtherBot: false }, () => ({ role: 'member', allowedToolNames: ['send_file', 'read_file'] }))
          const groupFacts = [c.payload, last].map(fact => ({ ...fact, chat_type: 'group' as const, chat_id: groupScope.chatId! }))
          await db.query("UPDATE conversation_sessions SET source='feishu',bot_id='91',chat_type='group',chat_id=$1", [groupScope.chatId])
          await db.query("UPDATE conversation_messages SET chat_type='group'")
          for (const [index, payload] of groupFacts.entries()) {
            const r = receipt({ ...c, scope: groupScope, actor: groupActor, payload })
            await db.query("UPDATE gugu_im_inbound_receipts SET chat_type='group',scope_hash=$1,event_hash=$2,fingerprint=$3,sealed_payload=$4 WHERE message_id=$5", [r.scope_hash, r.event_hash, r.fingerprint, r.sealed_payload, 11 + index])
          }
          await db.query('UPDATE chat_attachments SET extra=$1', [{ im_ingress_scope: imAttachmentScopeKey(groupScope) }])
          const grouped = aggregateImInboundPayloads(groupFacts.map((payload, index) => ({ payload, eventId: `179100000000${index}-1`, anchor: { messageId: 11 + index, conversationSeq: 3 + index } })))
          const groupedSender = (payload: Record<string, unknown>) => createImRunArtifactSender({ ...c, scope: groupScope, actor: groupActor, payload, pool: db, files, storageRoot: root, messageIds: ['11', '12'], sender: () => p.sender, authorize: async () => true })
          assert.equal(deliveryOutcome(await groupedSender(grouped)({ identity: c.identity, deliveryId: 'group-batch', artifact: { attach_id: 'attachment' } })), 'accepted')
          const groupMessage = p.requests.filter(r => new URL(r.url).pathname.endsWith('/messages')).at(-1)!
          assert.equal(JSON.parse(Buffer.from(groupMessage.body as Uint8Array).toString()).receive_id, groupScope.chatId)
          const groupCount = p.requests.length
          assert.equal(await groupedSender(grouped)({ identity: c.identity, deliveryId: 'member-private-file', artifact: { file_id: 1 } }), 'rejected')
          assert.throws(() => groupedSender({ ...grouped, chat_id: 'oc_other_group' }), /IM 运行投递范围不可用/u)
          await db.query('UPDATE chat_attachments SET extra=$1', [{ im_ingress_scope: 'other-group-scope' }])
          assert.equal(await groupedSender(grouped)({ identity: c.identity, deliveryId: 'cross-group-attachment', artifact: { attach_id: 'attachment' } }), 'rejected')
          assert.equal(p.requests.length, groupCount)
          await db.query("UPDATE conversation_sessions SET source='web',bot_id=NULL,chat_type=NULL,chat_id=NULL")
        }
        if (kind === 'qq') { assert.equal(p.requests.filter(r => r.method === 'PUT').length, 2); assert.equal(p.requests.filter(r => r.url.endsWith('/messages')).length, 2) }
        if (kind === 'wechat') { const cdn = p.requests.find(r => r.url.includes('/c2c/upload'))!; assert.notDeepEqual(Buffer.from(cdn.body as Uint8Array), data) }
      } finally { await p.close() }
    }
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() }
}))
