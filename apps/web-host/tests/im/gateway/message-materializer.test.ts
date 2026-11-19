import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { Pool } from 'pg'
import { assertDurableCanonical, prepareContext, type ContextReferenceCodec, type Json, type MessageEntry } from '@gugu/core/agent'
import { transcribeCompatibleAsr } from '@gugu/core/providers'
import { createImMessageMaterializer, ImMessageMaterializationError, ImVoiceUnavailableError } from '../../../src/modules/im/gateway/inbound/message.js'
import { createPostgresImAttachmentIngress, imAttachmentScopeKey, type ImAttachmentScope } from '../../../src/modules/im/gateway/inbound/attachments.js'

const owner = '00000000-0000-4000-8000-000000000101'
const identity = { ownerId: owner, sessionId: '10', runId: 'synthetic-run' }
const scope: ImAttachmentScope = { ownerId: owner, botId: '10', platform: 'telegram', chatType: 'group', chatId: 'synthetic-group', platformUserId: '202' }
const current = (id = '11') => ({ id, content: '不可信调用正文', contentJson: null, files: [], references: [] })
const row = (id = '11', sender = '201') => ({ id, content: `合成正文${id}`, content_json: null, files: [] as unknown[], quoted_text: '合成引用',
  platform_user_id: sender, platform_user_name: `合成成员${sender}`, message_ms: '1700000000000' })
const pass: ContextReferenceCodec = { dehydrate: async entry => structuredClone(entry.message), hydrate: async entry => structuredClone(entry.message) }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvL8AAAAASUVORK5CYII=', 'base64')
function entry(message: MessageEntry['message']): MessageEntry {
  return { entryId: 'synthetic-entry', sequence: 0, revision: 0, source: 'attachment', persistencePolicy: 'already_persisted', message }
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'gugu-im-materialize-'))
  let allowed = true, storageOverride: string | null = null
  const messages = [row()], attachments: Record<string, any>[] = [], queries: unknown[][] = []
  const pool = { async query(sql: string, args: unknown[] = []) {
    queries.push(args)
    if (sql.includes('gugu_im_inbound_receipts')) return { rows: args[0] === owner && args[1] === identity.sessionId && args[3] === identity.runId
      ? messages.filter(item => (args[2] as string[]).includes(item.id)) : [] }
    if (sql.includes('FROM chat_attachments WHERE')) return { rows: attachments.filter(item => item.message_id === args[1] && args[0] === owner) }
    if (sql.includes('FROM chat_attachments a')) return { rows: args[0] === owner && args[1] === identity.sessionId
      ? attachments.filter(item => item.attach_id === args[2]).map(item => ({ ...item, storage_key: storageOverride ?? item.storage_key })) : [] }
    throw new Error('未识别的查询契约')
  } } as unknown as Pick<Pool, 'query'>
  async function add(kind: string, ext: string, mime: string, bytes: Uint8Array, id = 'synthetic-attachment') {
    const key = `${owner}/.chat_staging/${id}.${ext}`
    await mkdir(path.dirname(path.join(directory, key)), { recursive: true })
    await writeFile(path.join(directory, key), bytes)
    attachments.push({ attach_id: id, name: '合成附件', ext, mime, kind, size: bytes.length, storage_key: key,
      message_id: 11, state: 'attached', extra: { im_ingress_scope: imAttachmentScopeKey(scope) }, duration: null, img_width: 1, img_height: 1 })
    messages[0]!.files.push({ attach_id: id, kind, name: '合成附件', ext })
    return attachments.at(-1)!
  }
  function create(extra: Partial<Parameters<typeof createImMessageMaterializer>[0]> = {}) {
    return createImMessageMaterializer({ pool, storageRoot: directory, identity, scope, messageIds: ['11'], timezone: 'UTC',
      formatMessageTime: value => `合成时间${value}`, authorize: async () => allowed, ...extra })
  }
  return { directory, messages, attachments, queries, add, create, revoke() { allowed = false }, overrideStorage(key: string) { storageOverride = key },
    async close() { await rm(directory, { recursive: true, force: true }) } }
}

test('当前消息只读持久owner/session/run锚点，批次保留业务顺序、speaker及引用并经真实Core去重历史', async () => {
  const f = await fixture()
  f.messages.push(row('12', '202'))
  try {
    const materializer = f.create({ messageIds: ['12', '11'] })
    const result = await materializer.materialize(identity, current())
    assert.equal(result.currentUser, undefined)
    assert.equal(result.currentUsersInHistory, false)
    assert.deepEqual(result.currentUsers!.map(user => user.persistedMessageId), ['12', '11'])
    assert.deepEqual(result.currentUsers!.map(user => user.rawText), ['合成正文12', '合成正文11'])
    const text = JSON.stringify(result.currentUsers)
    assert.match(text, /合成成员202/); assert.match(text, /合成成员201/); assert.match(text, /合成引用/)
    assert.equal(text.includes('不可信调用正文'), false)
    let serial = 0
    const prepared = await prepareContext({ ...identity, ...result, groupChat: true, fixedPrefix: [{ role: 'system', content: '合成系统上下文' }],
      history: [{ ...identity, id: '9', conversationSeq: 1, role: 'user', content: '真实既有历史' },
        ...f.messages.map((item, index) => ({ ...identity, id: item.id, conversationSeq: index + 2, role: 'user', content: item.content }))] },
    { digest: value => JSON.stringify(value), nextId: () => `entry-${++serial}`, buildRag: async () => ({ tail: [] }) })
    const messages = prepared.area.messages
    assert.equal(JSON.stringify(messages).match(/真实既有历史/g)?.length, 1)
    assert.equal(JSON.stringify(messages).match(/合成正文11/g)?.length, 1)
    assert.equal(JSON.stringify(messages).match(/合成正文12/g)?.length, 1)
  } finally { await f.close() }
})

test('文本附件真实读取私有本地字节，缺失文件或提取器不能伪装空上下文', async () => {
  const f = await fixture()
  try {
    const attachment = await f.add('text', 'txt', 'text/plain', Buffer.from('合成附件真实正文'))
    assert.match(JSON.stringify(await f.create().materialize(identity, current())), /合成附件真实正文/)
    await rm(path.join(f.directory, attachment.storage_key))
    await assert.rejects(f.create().materialize(identity, current()), ImMessageMaterializationError)
  } finally { await f.close() }
})

test('图片读取真实字节进入Canonical，checkpoint仅稳定引用，重建重新检查owner与存储', async () => {
  const f = await fixture()
  try {
    const stored = await f.add('image', 'png', 'image/png', png)
    const materializer = f.create(), result = await materializer.materialize(identity, current())
    const message = result.currentUser!.message, serialized = JSON.stringify(message)
    assert.match(serialized, new RegExp(png.toString('base64').slice(0, 16)))
    const codec = materializer.references(pass)
    const reordered = structuredClone(message)
    reordered.content = (reordered.content as Array<Record<string, Json>>).map(block => {
      if (block.type !== 'image') return block
      const source = block.source as Record<string, Json>
      return { source: { data: source.data!, media_type: source.media_type!, type: source.type! }, type: 'image' }
    })
    // Canonical等价重排不得使同一授权图片失去稳定引用映射。
    assertDurableCanonical(await codec.dehydrate(entry(reordered), identity))
    const durable = await codec.dehydrate(entry(message), identity)
    assertDurableCanonical(durable)
    assert.equal(JSON.stringify(durable).includes(png.toString('base64')), false)
    assert.equal((durable.content as Json[]).filter(block => !!block && typeof block === 'object' && !Array.isArray(block) && block.type === 'attachment_ref').length, 1)
    const restored = await codec.hydrate(entry(durable), identity)
    assert.match(JSON.stringify(restored), new RegExp(png.toString('base64').slice(0, 16)))
    assert.deepEqual(await readFile(path.join(f.directory, stored.storage_key)), png)
    f.revoke()
    await assert.rejects(codec.hydrate(entry(durable), identity), ImMessageMaterializationError)
  } finally { await f.close() }
})

for(const kind of ['image','voice'] as const)test(`${kind}相同字节保留每个原附件及批次消息身份，重复checkpoint/重建不串引用`,async()=>{
  const f=await fixture(),bytes=kind==='image'?png:Buffer.from('synthetic-identical-native-audio')
  try{
    const first=await f.add(kind,kind==='image'?'png':'wav',kind==='image'?'image/png':'audio/wav',bytes,'same-first')
    const second=await f.add(kind,first.ext,first.mime,bytes,'same-second')
    if(kind==='voice')second.extra.quoted=true
    const third=await f.add(kind,first.ext,first.mime,bytes,'same-other-message')
    third.message_id=12
    const other=row('12','202');other.files.push(f.messages[0]!.files.pop()!);f.messages.push(other)
    let quoteChecks=0
    const options={messageIds:['12','11'],async nativeAudio(input:{bytes:Uint8Array}){return{type:'input_audio',input_audio:{format:'wav',data:Buffer.from(input.bytes).toString('base64')}}},
      async assertQuotedAudio(input:{attachId:string}){assert.equal(input.attachId,'same-second');quoteChecks++}}
    const materializer=f.create(options),result=await materializer.materialize(identity,current()),codec=materializer.references(pass)
    const durable=await Promise.all(result.currentUsers!.map(user=>codec.dehydrate(entry(user.message),identity)))
    const refs=(message:MessageEntry['message'])=>(message.content as Array<Record<string,Json>>).filter(block=>block.type==='attachment_ref').map(block=>block.attach_id)
    assert.deepEqual(durable.map(refs),[['same-other-message'],['same-first','same-second']])
    for(const message of durable)assertDurableCanonical(message)
    // 新materializer没有原内存登记；hydrate并发读文件的完成顺序不能决定下一次checkpoint身份。
    const fresh=f.create(options),freshCodec=fresh.references(pass)
    const restored=await Promise.all(durable.map(message=>freshCodec.hydrate(entry(message),identity)))
    for(let i=0;i<2;i++)assert.deepEqual((await Promise.all(restored.map(message=>freshCodec.dehydrate(entry(structuredClone(message)),identity)))).map(refs),durable.map(refs))
    if(kind==='voice')assert.equal(quoteChecks,4)
    const ambiguous=structuredClone(restored[1]!);delete ambiguous._history_id
    await assert.rejects(freshCodec.dehydrate(entry(ambiguous),identity),ImMessageMaterializationError)
    await rm(path.join(f.directory,first.storage_key))
    await assert.rejects(freshCodec.hydrate(entry(durable[1]!),identity),ImMessageMaterializationError,'第一个附件缺失不能借相同字节的第二个附件恢复')
  }finally{await f.close()}
})

test('音频经真实兼容ASR协议+ProviderTransport替身，未配置ASR明确失败', async () => {
  const f = await fixture()
  try {
    await f.add('voice', 'wav', 'audio/wav', Buffer.from('synthetic-audio-bytes'))
    await assert.rejects(f.create().materialize(identity, current()), ImMessageMaterializationError)
    let calls = 0
    const materializer = f.create({ async transcribe(input, signal) {
      return transcribeCompatibleAsr([{ type: 'audio', raw: input.bytes, mime: input.mime, ext: input.ext }],
        { provider: 'local', model: 'synthetic-asr', api_format: 'openai', base_url: 'https://provider.example/v1', api_key: 'synthetic-key' },
        { digest: () => 'synthetic', async toWav(bytes) { return bytes }, transport: { async request(request) {
          calls++; assert.equal(request.url, 'https://provider.example/v1/chat/completions')
          assert.match(JSON.stringify(request.body), new RegExp(Buffer.from(input.bytes).toString('base64')))
          return { status: 200, headers: {}, body: (async function* () { yield Buffer.from('{"choices":[{"message":{"content":"合成真实协议转写"}}]}') })(), cancel() {} }
        } } }, signal ?? new AbortController().signal, { raiseErrors: true })
    } })
    assert.match(JSON.stringify(await materializer.materialize(identity, current())), /合成真实协议转写/)
    assert.equal(calls, 1)
  } finally { await f.close() }
})

test('原生音频只读已授权附件，checkpoint使用稳定引用；恢复后重新授权且不调用独立ASR', async () => {
  const f = await fixture(), bytes = Buffer.from('synthetic-native-audio')
  try {
    await f.add('voice', 'wav', 'audio/wav', bytes)
    let nativeCalls = 0, asrCalls = 0
    const materializer = f.create({ async nativeAudio(input) {
      nativeCalls++; assert.deepEqual(input.bytes, bytes)
      return { type: 'input_audio', input_audio: { format: 'wav', data: `data:audio/wav;base64,${Buffer.from(input.bytes).toString('base64')}` } }
    }, async transcribe() { asrCalls++; throw new Error('原生音频不应借ASR代替') } })
    const result = await materializer.materialize(identity, current())
    assert.match(JSON.stringify(result), /input_audio/)
    const codec = materializer.references(pass), original = entry(result.currentUser!.message)
    const durable = await codec.dehydrate(original, identity)
    assertDurableCanonical(durable)
    assert.equal(JSON.stringify(durable).includes(bytes.toString('base64')), false)
    assert.match(JSON.stringify(durable), /attachment_ref/)
    const restored = await codec.hydrate(entry(durable), identity)
    assert.match(JSON.stringify(restored), /input_audio/)
    assert.equal(nativeCalls, 2); assert.equal(asrCalls, 0)
    f.revoke()
    await assert.rejects(codec.hydrate(entry(durable), identity), ImMessageMaterializationError)
    assert.equal(nativeCalls, 2)
  } finally { await f.close() }
})

test('引用语音必须有来源证明；字幕仅入引用上下文，本消息转录只聚合自身声源',async()=>{
  const f=await fixture()
  try{
    const quoted=await f.add('voice','wav','audio/wav',Buffer.from('synthetic-quoted-audio'),'quoted-voice')
    quoted.extra={...quoted.extra,quoted:true};Object.assign(f.messages[0]!.files[0] as object,{quoted:true})
    await f.add('voice','wav','audio/wav',Buffer.from('synthetic-own-audio'),'own-voice')
    let calls=0,checks=0;const saved:string[]=[]
    await assert.rejects(f.create({async transcribe(){calls++;return'不应读取引用'}}).materialize(identity,current()),ImMessageMaterializationError)
    assert.equal(calls,0)
    const materializer=f.create({async assertQuotedAudio(input){checks++;assert.deepEqual(input,{messageId:'11',attachId:'quoted-voice'})},
      async transcribe(input){calls++;return input.attachId==='quoted-voice'?'原消息说的话':'当前用户说的话'},
      async persistTranscript(_messageId,text){assert.ok(text!==null);saved.push(text)}})
    const result=await materializer.materialize(identity,current()),user=result.currentUser!
    const quote=(user.message._history_envelope as {quote:{text:string}}).quote.text
    assert.match(quote,/原消息说的话/);assert.equal(quote.includes('当前用户说的话'),false)
    assert.deepEqual(saved,['当前用户说的话']);assert.equal(checks,2);assert.equal(calls,2)
    assert.equal(user.rawText,'合成正文11')
    let nativeChecks=0
    await assert.rejects(f.create({async assertQuotedAudio(){nativeChecks++;if(nativeChecks===2)throw Error('原引用撤销')},
      async nativeAudio(){return{type:'input_audio',input_audio:{format:'wav',data:'data:audio/wav;base64,AQID'}}}}).materialize(identity,current()),ImMessageMaterializationError)
    assert.equal(nativeChecks,2)
    let denied=false
    const native=f.create({async assertQuotedAudio(input){if(denied||input.messageId!=='11')throw Error('引用来源已撤销或缺少旧Run证明')},async nativeAudio(input){
      return{type:'input_audio',input_audio:{format:'wav',data:`data:audio/wav;base64,${Buffer.from(input.bytes).toString('base64')}`}}}})
    const prepared=await native.materialize(identity,current()),codec=native.references(pass)
    const durable=await codec.dehydrate(entry(prepared.currentUser!.message),identity)
    assert.match(JSON.stringify(await codec.hydrate(entry(durable),identity)),/input_audio/)
    quoted.message_id=9
    await assert.rejects(codec.hydrate(entry(durable),identity),ImMessageMaterializationError,'旧Run历史引用没有完整旧route时明确拒绝，不借当前Run proof放行')
    quoted.message_id=11;denied=true
    await assert.rejects(codec.hydrate(entry(durable),identity),ImMessageMaterializationError)
  }finally{await f.close()}
})

test('原生字幕只更新自身展示卡；引用只入quote，失败不丢音频，未配置不写状态，hydrate不重复识别',async()=>{
  for(const mode of ['completed','empty','failed','unconfigured'] as const){
    const f=await fixture(),saved:Array<{text:string|null;status:string}>=[];let calls=0,checks=0
    try{
      const quoted=await f.add('voice','wav','audio/wav',Buffer.from('synthetic-native-quote'),'quoted-native')
      quoted.extra={...quoted.extra,quoted:true};Object.assign(f.messages[0]!.files[0] as object,{quoted:true})
      await f.add('voice','wav','audio/wav',Buffer.from('synthetic-native-own'),'own-native')
      const materializer=f.create({async nativeAudio(input){return{type:'input_audio',input_audio:{format:'wav',data:Buffer.from(input.bytes).toString('base64')}}},
        async assertQuotedAudio(){checks++},async transcribeNative(input){
          calls++;if(mode==='unconfigured')return null
          return input.attachId==='quoted-native'?{text:'引用原声字幕',status:'completed'}:
            {text:mode==='completed'?'当前原声字幕':mode==='empty'?'':null,status:mode}
        },async persistTranscript(_id,text,status){saved.push({text,status})}})
      const user=(await materializer.materialize(identity,current())).currentUser!
      assert.equal(user.rawText,'合成正文11');assert.match(JSON.stringify(user.message.content),/input_audio/)
      assert.ok(!JSON.stringify(user.message.content).includes('当前原声字幕'),'附加展示字幕不作为正文重复喂主模型')
      const quote=(user.message._history_envelope as {quote:{text:string}}).quote.text
      if(mode!=='unconfigured')assert.match(quote,/引用原声字幕/)
      assert.ok(!quote.includes('当前原声字幕'))
      assert.deepEqual(saved,mode==='unconfigured'?[]:[{text:mode==='completed'?'当前原声字幕':mode==='empty'?'':null,status:mode}])
      const codec=materializer.references(pass),durable=await codec.dehydrate(entry(user.message),identity)
      assertDurableCanonical(durable);await codec.hydrate(entry(durable),identity)
      assert.equal(calls,2,'恢复稳定音频ref只重授权，不重复付费ASR');assert.ok(checks>=4)
    }finally{await f.close()}
  }
})

test('独立ASR未配置与实际空识别保留不同语义，转写等待期间撤权不返回正文', async () => {
  const f = await fixture()
  try {
    await f.add('voice', 'wav', 'audio/wav', Buffer.from('synthetic-audio'))
    await assert.rejects(f.create({ transcribe: async () => null }).materialize(identity, current()), ImVoiceUnavailableError)
    const empty = await f.create({ transcribe: async () => '' }).materialize(identity, current())
    assert.match(JSON.stringify(empty), /用户发来一段语音，但这次没听清内容/)
    await assert.rejects(f.create({ async transcribe() { f.revoke(); return '撤权后禁止返回' } }).materialize(identity, current()), ImMessageMaterializationError)
  } finally { await f.close() }
})

test('跨owner/run/锚点、未claim附件、错误群scope和伪造storage_key均failclosed', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.create().materialize({ ...identity, runId: 'another-run' }, current()), ImMessageMaterializationError)
    await assert.rejects(f.create().materialize(identity, current('12')), ImMessageMaterializationError)
    await f.add('image', 'png', 'image/png', png)
    const attachment = f.attachments[0]!
    attachment.extra.im_ingress_scope = 'other-group'
    await assert.rejects(f.create().materialize(identity, current()), ImMessageMaterializationError)
    attachment.extra.im_ingress_scope = imAttachmentScopeKey(scope)
    f.overrideStorage('00000000-0000-4000-8000-000000000102/.chat_staging/private.png')
    await assert.rejects(f.create().materialize(identity, current()), ImMessageMaterializationError)
    f.overrideStorage(attachment.storage_key); attachment.message_id = 99
    await assert.rejects(f.create().materialize(identity, current()), ImMessageMaterializationError)
  } finally { await f.close() }
})

test('取消与失真图片均静态失败，不暴露文件路径/原异常或假称图片已处理', async () => {
  const f = await fixture()
  try {
    await f.add('image', 'png', 'image/png', Buffer.from('synthetic-not-an-image'))
    await assert.rejects(f.create().materialize(identity, current()), { message: 'IM 消息上下文无法恢复' })
    const cancel = new AbortController(); cancel.abort(new Error('synthetic-private-body'))
    await assert.rejects(f.create().materialize(identity, current(), cancel.signal), error => error instanceof ImMessageMaterializationError && !('cause' in error))
  } finally { await f.close() }
})

test('128条批次与Core/dispatch上限一致，129条在查询前拒绝且不静默截断', async () => {
  const f = await fixture()
  try {
    const ids = Array.from({ length: 128 }, (_, index) => String(index + 1))
    f.messages.splice(0, f.messages.length, ...ids.map(id => row(id)))
    const result = await f.create({ messageIds: ids }).materialize(identity, current('128'))
    assert.equal(result.currentUsers?.length, 128)
    assert.deepEqual(result.currentUsers!.map(user => user.persistedMessageId), ids)
    const queries = f.queries.length
    assert.throws(() => f.create({ messageIds: [...ids, '129'] }), ImMessageMaterializationError)
    assert.equal(f.queries.length, queries)
  } finally { await f.close() }
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PG+FS：正式stage/claim锚点经真实物化SQL到Canonical与稳定checkpoint，跨群不可读取', {
  skip: !pgUrl && '未运行：需显式GUGU_IM_GATEWAY_TEST_DATABASE_URL；消息查询替身不证明真实owner/session/run隔离',
}, async () => {
  const { Pool } = await import('pg')
  const schema = `im_materializer_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: pgUrl })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-im-materializer-pg-'))
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}`, max: 1 })
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,chat_id text,source text,bot_id text,chat_type text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,content text,content_json jsonb,files jsonb,quoted_text text,
        platform_user_id text,platform_user_name text,im_platform_sent_ms bigint,im_event_received_ms bigint,created_at timestamptz,run_id text,chat_type text);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,state text,platform text,bot_id text,chat_type text);
      CREATE TABLE chat_attachments(attach_id text PRIMARY KEY,user_id uuid,message_id integer,storage_key text,platform text,platform_message_id text,
        attachment_index integer,name text,ext text,mime text,kind text,size bigint,duration double precision,img_width integer,img_height integer,state text,extra jsonb,
        created_at timestamptz,attached_at timestamptz)`)
    await pool.query("INSERT INTO users VALUES($1,true,'active');", [owner])
    await pool.query("INSERT INTO user_bots VALUES(10,$1,'telegram',true,true,NULL)", [owner])
    await pool.query("INSERT INTO conversation_sessions VALUES(10,$1,$2,'telegram','10','group')", [owner, scope.chatId])
    const database = pool
    const storage = createPostgresImAttachmentIngress({ pool: database, storageRoot: root, tempDirectory: root, supportedPlatforms: () => ['telegram'] })
    const staged = await storage.stage({ scope, sourcePlatformMessageId: 'synthetic-pg-message', sourceAttachmentIndex: 0,
      name: '合成图片', ext: 'png', mime: 'image/png', bytes: png })
    const duplicate = await storage.stage({ scope, sourcePlatformMessageId: 'synthetic-pg-message', sourceAttachmentIndex: 1,
      name: '第二张相同字节图片', ext: 'png', mime: 'image/png', bytes: png })
    const attachmentIds=[staged.attachId,duplicate.attachId]
    const attachments = storage.conversation(scope)
    if (attachments.mode !== 'enabled') throw new Error('附件模式无效')
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      const cards = await attachments.resolve(client, owner, attachmentIds)
      await client.query(`INSERT INTO conversation_messages VALUES(11,10,'user','数据库里的实际正文',NULL,$1::jsonb,'数据库引用','201','合成小北',1700000000000,NULL,clock_timestamp(),$2,'group')`,
      [JSON.stringify(cards), identity.runId])
      await attachments.claim(client, owner, 11, attachmentIds)
      await client.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,10,11,$2,'dispatched','telegram','10','group')", [owner, identity.runId])
      await client.query('COMMIT')
    } finally { client.release() }
    const options = { pool: database, storageRoot: root, identity, scope, messageIds: ['11'], timezone: 'UTC', formatMessageTime: () => '合成时间', authorize: async () => true }
    const materializer = createImMessageMaterializer(options), result = await materializer.materialize(identity, current())
    assert.equal(result.currentUser!.rawText, '数据库里的实际正文')
    assert.match(JSON.stringify(result.currentUser!.message), /数据库引用|合成小北/)
    const codec = materializer.references(pass), durable = await codec.dehydrate(entry(result.currentUser!.message), identity)
    assert.deepEqual((durable.content as Array<Record<string,Json>>).filter(block=>block.type==='attachment_ref').map(block=>block.attach_id),attachmentIds)
    assertDurableCanonical(durable)
    assert.equal(JSON.stringify(durable).includes(png.toString('base64')), false)
    assert.match(JSON.stringify(await codec.hydrate(entry(durable), identity)), new RegExp(png.toString('base64').slice(0, 16)))
    await assert.rejects(createImMessageMaterializer({ ...options, scope: { ...scope, chatId: 'other-group' } }).materialize(identity, current()), ImMessageMaterializationError)
    await assert.rejects(createImMessageMaterializer({ ...options, identity: { ...identity, runId: 'other-run' } }).materialize({ ...identity, runId: 'other-run' }, current()), ImMessageMaterializationError)
    for (const update of ["bot_id='11'", "source='qq'", "chat_type='c2c'"]) {
      await database.query(`UPDATE conversation_sessions SET ${update}`)
      await assert.rejects(materializer.materialize(identity, current()), ImMessageMaterializationError)
      await database.query("UPDATE conversation_sessions SET bot_id='10',source='telegram',chat_type='group'")
    }
    const privateScope = { ...scope, chatType: 'c2c' as const, chatId: null }
    await database.query("UPDATE conversation_sessions SET source='web',bot_id=NULL,chat_type=NULL,chat_id=NULL")
    await database.query("UPDATE conversation_messages SET chat_type='c2c',platform_user_id=$1", [scope.platformUserId])
    await database.query("UPDATE gugu_im_inbound_receipts SET chat_type='c2c'")
    await database.query('UPDATE chat_attachments SET extra=$1', [{ im_ingress_scope: imAttachmentScopeKey(privateScope) }])
    const privateMaterializer = createImMessageMaterializer({ ...options, scope: privateScope })
    assert.equal((await privateMaterializer.materialize(identity, current())).currentUser!.rawText, '数据库里的实际正文')
    await assert.rejects(createImMessageMaterializer({ ...options, scope: { ...privateScope, platformUserId: 'other-speaker' } }).materialize(identity, current()), ImMessageMaterializationError)
  } finally {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
