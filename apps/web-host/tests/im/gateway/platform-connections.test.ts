import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Agent } from 'node:https'
import { test } from 'node:test'
import type { EventDispatcher } from '@larksuiteoapi/node-sdk'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'
import type { ImPreflightPorts } from '@gugu/core/im/inbound-preflight'
import { createPlatformConnections, type GatewayConnectionServices } from '../../../src/modules/im/gateway/platform-connections.js'
import { createImInboundEnvelope } from '../../../src/modules/im/gateway/inbound/envelope.js'
import type { TrustedGatewayBot } from '../../../src/modules/im/gateway/bot-config.js'
import { encryptAesEcb } from '@gugu/gateway/wechat'
import type { QqSocket } from '@gugu/gateway/qq'
import { ImGatewayAdmissionError } from '../../../src/modules/im/gateway/inbound/admission.js'
import {createGatewaySupervisor,GatewayConnectionCleanupError,type GatewayClock} from '@gugu/gateway'

const secret = 'synthetic-envelope-master', owner = '11111111-1111-4111-8111-111111111111'
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const token = '123456789:synthetic_telegram_token_abcdefghijklmnopqrstuvwxyz'
const spec = (platform: TrustedGatewayBot['platform']): TrustedGatewayBot => ({ key: `${platform}:4`, id: '4', owner,
  platform, revision: 'synthetic-revision', sandbox: false, credentials: {
    appId: platform === 'feishu' ? 'cli_0123456789abcdef' : platform === 'wechat' ? 'https://ilinkai.weixin.qq.com' : 'synthetic-app',
    appSecret: platform === 'telegram' ? token : 'synthetic-bot-secret' } })
async function until(check: () => boolean) { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise<void>(r => setImmediate(r)) } assert.ok(check(), '预期入站状态未出现') }
const response = (value: unknown, status = 200) => ({ status, headers: {}, body: (async function* () { yield value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value)) })(), cancel() {} })
function waiting(signal: AbortSignal): Promise<never> { return new Promise((_resolve, reject) => { if (signal.aborted) reject(new Error('合成停止')); else signal.addEventListener('abort', () => reject(new Error('合成停止')), { once: true }) }) }

/** Redis命令、授权/交互状态、附件存储均为明确替身；实际parser/preflight/下载/加解密/入队及sender在运行。 */
function ports() {
  const wire: string[][] = [], order: string[] = [], stages: Array<Record<string, unknown>> = [], events: string[] = []
  let secretInput = false, fieldValues = 0, inspections = 0
  const receipts = new Map<string, { state: 'pending' | 'admitted' | 'consumed' | 'unknown'; fingerprint: string }>()
  const admissionKey = (scope: Parameters<GatewayConnectionServices['admission']['finish']>[0]) => JSON.stringify([
    scope.ownerId, scope.platform, scope.botId, scope.chatType, scope.chatId, scope.platformUserId, scope.eventId])
  const controls: Omit<ImPreflightPorts, 'reply'> = {
    authorize: async scope => { order.push('authorize'); assert.equal(scope.ownerId, owner); assert.equal(scope.botId, '4'); return true },
    inspectSecret: async () => { inspections++; return secretInput ? { status: 'awaiting_secret', reference: 'synthetic-stage-reference' } : { status: 'none' } },
    applySecret: async (_scope, reference, action) => { assert.equal(reference, 'synthetic-stage-reference'); if (action.action === 'value') fieldValues++; return { status: 'completed' } },
    bindQqOwnerIfUnbound: async scope => { events.push(`qq-first:${scope.platformUserId}`) },
    consumeBinding: async () => { throw new Error('此测试未配置绑定挑战') },
    consumeTextChoice: async () => null,
    decideShortcut: async (_scope, text) => text === '/stop' ? { action: 'cancel', reply: '已取消合成任务', reference: 'synthetic-exact-run' } : { action: 'run' },
    cancel: async scope => { events.push(`cancel:${scope.platformUserId}`); return true },
  }
  const services: GatewayConnectionServices = { controls,
    // 状态化准入替身；实际永久SQL并发与时间边界由admission-postgres测试验证。
    admission: {
      async begin(input) {
        const key = admissionKey(input.scope), fingerprint = JSON.stringify([input.text, input.quotedText, input.hasPendingMedia, input.mediaIds]), prior = receipts.get(key)
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new ImGatewayAdmissionError('conflict')
          if (prior.state === 'pending' || prior.state === 'unknown') throw new ImGatewayAdmissionError(prior.state)
          return { status: prior.state, receivedAt: '2026-01-01 00:00:00.123456+00', controlEventId: createHmac('sha256', secret).update(key).digest('hex') }
        }
        receipts.set(key, { state: 'pending', fingerprint })
        return { status: 'first', token: 'synthetic-token', receivedAt: '2026-01-01 00:00:00.123456+00', controlEventId: createHmac('sha256', secret).update(key).digest('hex') }
      },
      async finish(scope, _token, result) { receipts.get(admissionKey(scope))!.state = result === 'enqueue' ? 'admitted' : 'consumed' },
      async markUnknown(scope) { receipts.get(admissionKey(scope))!.state = 'unknown' },
    },
    attachments: {
      stage: async input => { order.push('stage'); stages.push({ ...input, bytes: Buffer.from(input.bytes) }); return { ownerId: input.scope.ownerId, attachId: `synthetic-attach-${stages.length}`, created: true, creationReceipt: `receipt-${stages.length}` } },
      reuse: async input => { events.push(`reuse:${input.sourcePlatformMessageId}:${input.targetPlatformMessageId}`); return null },
      release: async input => { events.push(`release:${input.creationReceipt}`) },
    },
    // 一次性动作消费的可控业务替身；不将平台ACK冒充Agent恢复。
    callback: async input => { assert.equal(input.binding.ownerId, owner); events.push(`callback:${input.platform}`); return { consumed: true, accepted: true } },
    prepareQq: async (scope, parsed) => { events.push(`qq-index:${scope.platformUserId}:${parsed.indexEntry.message_index}`); return parsed },
    telegramToken: async binding => { assert.equal(binding.ownerId, owner); assert.equal(binding.botId, '4'); return token },
  }
  const redis = { sendCommand: async (args: string[]) => {
    if (args[0] === 'GET') return null
    wire.push(args); order.push('redis')
    if (args[0] === 'EVAL' && args[2] === '1') return 1
    return args[1]!.includes('local stream, dedup, cursor') ? 1 : '1000-1'
  } }
  const entries = () => wire.filter(args => args[2] !== '1' && !!args[4 + Number(args[2])]).map(args => JSON.parse(args[4 + Number(args[2])]!))
  return { services, redis, wire, order, stages, events, entries, receipts, setSecret: () => { secretInput = true }, fields: () => fieldValues, inspections: () => inspections }
}

test('真实飞书连接→平台工厂→监督器：初次握手清理未知不退避替代，正常清理失败后仍可重试',async()=>{
 for(const cleanupUnknown of [true,false]){
  const p=ports();let now=0,created=0,closed=0
  const sleeps=new Set<{at:number;resolve():void}>()
  const clock:GatewayClock={now:()=>now,sleep(ms,signal){return new Promise<void>((resolve,reject)=>{
   const item={at:now+ms,resolve(){sleeps.delete(item);signal.removeEventListener('abort',abort);resolve()}}
   const abort=()=>{sleeps.delete(item);reject(Error('合成停止'))};sleeps.add(item);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
  })}}
  const connections=createPlatformConnections({redis:p.redis,secretKey:secret,services:()=>p.services,sanitizeText:value=>value,
   transport:()=>({async request(input){if(input.url.includes('/tenant_access_token/'))return response({code:0,tenant_access_token:'synthetic-access',expire:7200});if(input.url.endsWith('/bot/v3/info'))return response({code:0,data:{bot:{open_id:'ou_synthetic'}}});throw Error('未预期HTTP')},async close(){}}),
   feishuNetwork:()=>{const agent=new Agent();return{agent,async validateEndpoint(){},async close(){agent.destroy()}}},
   createFeishuSdk(options){const instance=++created;return{async start(){if(instance===1)options.onError!(new Error('synthetic-private-sdk-error'));else options.onReady!()},close(){closed++;if(cleanupUnknown)throw Error('synthetic-private-cleanup-error')}}}})
  const supervisor=createGatewaySupervisor({clock,read:async()=>[spec('feishu')],subscribe:async()=>({disconnected:new Promise<void>(()=>{}),async close(){}}),connect:connections.connect})
  await supervisor.start();await supervisor.settled()
  assert.equal(created,1);assert.equal(closed,1)
  if(cleanupUnknown){assert.equal(supervisor.health().cleanupUnknown,1);assert.equal(supervisor.health().running,0);assert.equal(supervisor.health().retrying,0)}
  else{assert.equal(supervisor.health().cleanupUnknown,0);assert.equal(supervisor.health().retrying,1)}
  now=300000;for(const item of [...sleeps])if(item.at<=now)item.resolve()
  for(let i=0;i<30;i++)await Promise.resolve();await supervisor.settled()
  if(cleanupUnknown){
   assert.equal(created,1)
   await assert.rejects(connections.connect(spec('feishu'),new AbortController().signal),GatewayConnectionCleanupError)
   await assert.rejects(supervisor.stop(),error=>error instanceof GatewayConnectionCleanupError&&!error.message.includes('synthetic-private')&&!('cause'in error))
  }else{assert.equal(created,2);assert.equal(supervisor.health().running,1);await supervisor.stop();assert.equal(closed,2)}
 }
})

test('平台初始失败时media或client关闭未知均保留typed错误与blocked归属，不因尚无connection而丢失',async()=>{
 for(const kind of ['media','client']){
  const p=ports(),bot=spec(kind==='media'?'telegram':'feishu');let requests=0,mediaCloses=0,clientCloses=0
  const runtime=createPlatformConnections({redis:p.redis,secretKey:secret,services:()=>p.services,sanitizeText:value=>value,
   feishuNetwork:()=>{throw Error('API初始化失败不得开始WS')},transport:(_bot,purpose)=>({
    async request(input){requests++;if(input.url.includes('/tenant_access_token/'))return response({code:0,tenant_access_token:'synthetic-access',expire:7200});return response({ok:false,error_code:401,code:9999},401)},
    async close(){if(purpose==='media'){mediaCloses++;if(kind==='media')throw Error('synthetic-private-media-cleanup')}else{clientCloses++;if(kind==='client')throw Error('synthetic-private-client-cleanup')}}})})
  await assert.rejects(runtime.connect(bot,new AbortController().signal),error=>error instanceof GatewayConnectionCleanupError&&!error.message.includes('synthetic-private')&&!('cause'in error))
  assert.ok(mediaCloses>=1);assert.ok(clientCloses>=1)
  const count=requests
  await assert.rejects(runtime.connect(bot,new AbortController().signal),GatewayConnectionCleanupError);assert.equal(requests,count)
 }
})
test('Telegram初始getMe失败且API.close失败保留未知归属，不重复close掩盖首次失败',async()=>{
 const p=ports();let requests=0,apiCloses=0
 const runtime=createPlatformConnections({redis:p.redis,secretKey:secret,services:()=>p.services,sanitizeText:value=>value,transport:(_bot,purpose)=>({
  async request(){requests++;return response({ok:false,error_code:401},401)},async close(){if(purpose==='api'){apiCloses++;throw Error('synthetic-private-api-cleanup')}}})})
 await assert.rejects(runtime.connect(spec('telegram'),new AbortController().signal),GatewayConnectionCleanupError)
 assert.equal(requests,1);assert.equal(apiCloses,1)
 await assert.rejects(runtime.connect(spec('telegram'),new AbortController().signal),GatewayConnectionCleanupError)
 assert.equal(requests,1);assert.equal(apiCloses,1)
})
test('Telegram实际HTTP适配/解析→Core预检→getFile下载/暂存→密封cursor inbox；控制消息不下载或入队', async () => {
  const p = ports(), requests: ProviderHttpRequest[] = [], controller = new AbortController()
  let batch = 0, enteredPoll = false
  const transport: ProviderTransport = { async request(input, signal) {
    requests.push(input)
    if (input.url.endsWith('/getMe')) return response({ ok: true, result: { id: 99, username: 'gugu_bot' } })
    if (input.url.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '' } })
    if (input.url.endsWith('/getUpdates')) {
      if (batch++ === 0) return response({ ok: true, result: [{ update_id: 1, message: { message_id: 31, date: 100,
        chat: { id: 9, type: 'private' }, from: { id: 9, first_name: '合成小北' }, photo: [{ file_id: 'synthetic-file', file_size: png.length, width: 1, height: 1 }], caption: '合成图片', owner_user_id: 'forged-owner' } }] })
      enteredPoll = true; return waiting(signal)
    }
    if (input.url.endsWith('/getFile')) { p.order.push('download'); return response({ ok: true, result: { file_path: 'photos/synthetic.png', file_size: png.length } }) }
    if (input.url.includes('/file/bot')) return response(png)
    throw new Error('未预期的合成平台方法')
  }, async close() {} }
  const runtime = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => p.services, sanitizeText: value => value, transport: () => transport })
  const connection = await runtime.connect(spec('telegram'), controller.signal)
  await until(() => enteredPoll)
  assert.equal(p.stages.length, 1); assert.deepEqual(p.stages[0]!.bytes, png)
  assert.ok(p.order.indexOf('authorize') < p.order.indexOf('download')); assert.ok(p.order.indexOf('stage') < p.order.indexOf('redis'))
  const saved = p.entries()[0]!, opened = createImInboundEnvelope(secret).open({ platform: 'telegram', botId: '4', ownerId: owner }, saved)
  assert.equal(createImInboundEnvelope(secret).openForWorker({ platform: 'telegram', botId: '4', ownerId: owner }, saved).admission, 'gateway')
  assert.equal(opened.owner_user_id, owner); assert.deepEqual(opened.attachments, ['synthetic-attach-1'])
  assert.ok(!JSON.stringify(p.wire).includes('合成图片')); assert.equal(runtime.sender({ platform: 'telegram', botId: '4', ownerId: 'other' }), null)
  await connection.stop(); assert.equal(runtime.sender({ platform: 'telegram', botId: '4', ownerId: owner }), null)

  const blocked = ports(); blocked.setSecret(); let polls = 0, replies = 0
  const controlTransport: ProviderTransport = { async request(input, signal) {
    if (input.url.endsWith('/getMe')) return response({ ok: true, result: { id: 99 } })
    if (input.url.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '' } })
    if (input.url.endsWith('/getUpdates') && polls++ === 0) return response({ ok: true, result: [{ update_id: 2, message: { message_id: 32, date: 100, chat: { id: 9, type: 'private' }, from: { id: 9 }, photo: [{ file_id: 'secret-file' }], caption: 'synthetic-secret' } }] })
    if (input.url.endsWith('/getUpdates')) return waiting(signal)
    if (input.url.endsWith('/sendMessage')) { replies++; const body = JSON.parse(Buffer.from(input.body as Uint8Array).toString()); assert.equal(body.reply_parameters, undefined); assert.ok(!JSON.stringify(body).includes('synthetic-secret')); return response({ ok: true, result: { message_id: 88 } }) }
    throw new Error('秘密态不应下载附件')
  }, async close() {} }
  const secure = createPlatformConnections({ redis: blocked.redis, secretKey: secret, services: () => blocked.services, sanitizeText: value => value, transport: () => controlTransport })
  const secureConnection = await secure.connect(spec('telegram'), new AbortController().signal)
  await until(() => replies === 1); assert.equal(blocked.stages.length, 0); assert.equal(blocked.fields(), 0)
  assert.equal(blocked.entries().length, 0)
  await secureConnection.stop()
})
test('微信实际iLink轮询→Core预检→CDN下载及AES解密→owner暂存→密封Node inbox', async () => {
  const p = ports(), key = Buffer.from('00112233445566778899aabbccddeeff', 'hex'), requests: ProviderHttpRequest[] = []
  let polls = 0, waitingPoll = false
  const transport: ProviderTransport = { async request(input, signal) {
    requests.push(input)
    if (input.url.endsWith('/getupdates')) {
      if (polls++ === 0) return response({ ret: 0, get_updates_buf: 'cursor-a', msgs: [{ message_type: 1, from_user_id: 'member-a', context_token: 'synthetic-context', message_id: 'wx-a',
        item_list: [{ type: 1, text_item: { text: '合成微信' } }, { type: 2, image_item: { aeskey: key.toString('hex'), media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=synthetic-cdn' } } }] }] })
      waitingPoll = true; return waiting(signal)
    }
    if (input.url.includes('/c2c/download')) { p.order.push('download'); return response(encryptAesEcb(png, key)) }
    if (input.url.endsWith('/notifystart') || input.url.endsWith('/notifystop')) return response({ ret: 0 })
    throw new Error('未预期的合成iLink方法')
  }, async close() {} }
  const runtime = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => p.services, sanitizeText: value => value, transport: () => transport })
  const connection = await runtime.connect(spec('wechat'), new AbortController().signal)
  await until(() => waitingPoll)
  assert.deepEqual(p.stages[0]!.bytes, png); assert.ok(p.order.indexOf('authorize') < p.order.indexOf('download'))
  const payload = createImInboundEnvelope(secret).open({ platform: 'wechat', botId: '4', ownerId: owner }, p.entries()[0]!)
  assert.equal(createImInboundEnvelope(secret).openForWorker({ platform: 'wechat', botId: '4', ownerId: owner }, p.entries()[0]!).admission, 'gateway')
  assert.equal(payload.context_token, 'synthetic-context'); assert.deepEqual(payload.attachments, ['synthetic-attach-1'])
  assert.ok(!JSON.stringify(p.wire).includes('synthetic-context')); assert.ok(!JSON.stringify(p.wire).includes(key.toString('hex')))
  await connection.stop(); assert.ok(requests.some(input => input.url.endsWith('/notifystop')))
})

test('永久Gateway准入在新secret stage下重投旧事件仍不重跑控制，cutoff和control ID仅来自可信收据', async () => {
  const p = ports(), scopes: Array<{ eventId: string; admissionCutoff?: string }> = []
  p.services.controls.authorize = async scope => { scopes.push(scope); return true }
  let polls = 0, waitingPoll = false
  const message = { message_type: 1, from_user_id: 'member-a', context_token: 'synthetic-old-context-token',
    admissionCutoff: '2099-01-01 00:00:00+00', item_list: [{ type: 1, text_item: { text: '排队之前的普通文本' } }] }
  const transport: ProviderTransport = { async request(input, signal) {
    if (input.url.endsWith('/getupdates')) {
      if (polls++ < 2) { if (polls === 2) p.setSecret(); return response({ ret: 0, get_updates_buf: 'synthetic-cursor', msgs: [message] }) }
      waitingPoll = true; return waiting(signal)
    }
    if (input.url.endsWith('/getconfig')) return response({ ret: 0, typing_ticket: `synthetic-ticket-${polls}` })
    if (input.url.endsWith('/notifystart') || input.url.endsWith('/notifystop')) return response({ ret: 0 })
    throw new Error('未预期的合成iLink方法')
  }, async close() {} }
  const runtime = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => p.services, sanitizeText: value => value, transport: () => transport })
  const connection = await runtime.connect(spec('wechat'), new AbortController().signal)
  try {
    await until(() => waitingPoll && p.entries().length === 2)
    assert.equal(p.inspections(), 1); assert.equal(p.fields(), 0); assert.equal(p.receipts.size, 1)
    assert.equal([...p.receipts.values()][0]!.state, 'admitted')
    assert.ok(scopes.length > 0)
    for (const scope of scopes) { assert.match(scope.eventId, /^[a-f0-9]{64}$/u); assert.equal(scope.admissionCutoff, '2026-01-01 00:00:00.123456+00') }
    assert.equal(p.entries()[0]!.message_id, p.entries()[1]!.message_id)
  } finally { await connection.stop() }
})

test('控制执行异常永久标记unknown，重投不进入新stage或Agent，健康报告固定原因', async () => {
  const p = ports(), reports: string[] = []; let decisions = 0, polls = 0, waitingPoll = false
  p.services.controls.decideShortcut = async () => { decisions++; throw new Error('合成敏感控制失败正文') }
  const transport: ProviderTransport = { async request(input, signal) {
    if (input.url.endsWith('/getupdates')) {
      if (polls++ < 2) { if (polls === 2) p.setSecret(); return response({ ret: 0, msgs: [{ message_type: 1, from_user_id: 'member-a',
        context_token: 'synthetic-uncertain-context', item_list: [{ type: 1, text_item: { text: '普通消息' } }] }] }) }
      waitingPoll = true; return waiting(signal)
    }
    if (input.url.endsWith('/notifystart') || input.url.endsWith('/notifystop')) return response({ ret: 0 })
    throw new Error('未预期的合成iLink方法')
  }, async close() {} }
  const runtime = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => p.services, sanitizeText: value => value,
    transport: () => transport, clock: { now: () => 0, sleep: async (_ms, signal) => { signal.throwIfAborted() } }, report: code => { reports.push(code) } })
  const connection = await runtime.connect(spec('wechat'), new AbortController().signal)
  try {
    await until(() => waitingPoll)
    assert.equal(decisions, 1); assert.equal(p.fields(), 0); assert.equal(p.entries().length, 0)
    assert.equal([...p.receipts.values()][0]!.state, 'unknown')
    assert.ok(reports.includes('admission-unknown')); assert.equal(JSON.stringify(reports).includes('敏感'), false)
  } finally { await connection.stop() }
})
test('飞书实际SDK事件dispatcher→Core parser/preflight→资源HTTP下载→密封inbox；卡片交给业务消费', async () => {
  const p = ports(), agent = new Agent(); let dispatcher!: EventDispatcher
  const reactions: Array<{ message: string; emoji: string }> = []
  let failReaction = false
  const transport: ProviderTransport = { async request(input) {
    if (input.url.includes('/tenant_access_token/')) return response({ code: 0, tenant_access_token: 'synthetic-access', expire: 7200 })
    if (input.url.endsWith('/bot/v3/info')) return response({ code: 0, data: { bot: { open_id: 'ou_bot' } } })
    if (input.url.endsWith('/reactions')) {
      const body=JSON.parse(Buffer.from(input.body as Uint8Array).toString())
      reactions.push({message:new URL(input.url).pathname.split('/').at(-2)!,emoji:body.reaction_type.emoji_type})
      p.order.push('reaction')
      return response(failReaction?{code:99991663,msg:'synthetic-private-rejection'}:{code:0,data:{reaction_id:'synthetic-reaction'}})
    }
    if (input.url.includes('/resources/')) { p.order.push('download'); return response(png) }
    if (input.url.endsWith('/callback/ws/endpoint')) return response({ code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/ws/v2?ticket=synthetic', ClientConfig: {} } })
    throw new Error('未预期的合成飞书API')
  }, async close() {} }
  const runtime = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => p.services, sanitizeText: value => value,
    transport: () => transport, now: () => 1_800_000_000_000,
    feishuNetwork: () => ({ agent, validateEndpoint: async url => { assert.ok(url.startsWith('wss://msg-frontier.feishu.cn/')) }, close: async () => { agent.destroy() } }),
    createFeishuSdk: config => ({ start: async input => { dispatcher = input.eventDispatcher; await config.httpInstance!.request({ method: 'post', url: 'https://open.feishu.cn/callback/ws/endpoint', data: { AppID: spec('feishu').credentials.appId, AppSecret: spec('feishu').credentials.appSecret } }); config.onReady!() }, async close() {} }) })
  const connection = await runtime.connect(spec('feishu'), new AbortController().signal)
  await dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', app_id: spec('feishu').credentials.appId, create_time: '1800000000000', event_id: 'feishu-event' },
    event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_member' } }, message: { message_id: 'om_a', chat_id: 'oc_a', chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: 'img_a' }), mentions: [] } } }, { needCheck: false })
  assert.equal(p.stages.length, 1); assert.ok(p.order.indexOf('authorize') < p.order.indexOf('download'))
  assert.ok(p.order.indexOf('reaction')<p.order.indexOf('download'),'即时反馈在下载/入队之前')
  assert.deepEqual(reactions,[{message:'om_a',emoji:'OnIt'}])
  assert.deepEqual(createImInboundEnvelope(secret).open({ platform: 'feishu', botId: '4', ownerId: owner }, p.entries()[0]!).attachments, ['synthetic-attach-1'])
  assert.equal(createImInboundEnvelope(secret).openForWorker({ platform: 'feishu', botId: '4', ownerId: owner }, p.entries()[0]!).admission, 'gateway')
  const emit=async(messageId:string,eventId:string,text:string)=>dispatcher.invoke({schema:'2.0',header:{event_type:'im.message.receive_v1',app_id:spec('feishu').credentials.appId,create_time:'1800000000000',event_id:eventId},
    event:{sender:{sender_type:'user',sender_id:{open_id:'ou_member'}},message:{message_id:messageId,chat_id:'oc_a',chat_type:'p2p',message_type:'text',content:JSON.stringify({text}),mentions:[]}}},{needCheck:false})
  await emit('om_thanks','feishu-thanks','THANKS')
  await emit('om_thanks','feishu-thanks','THANKS')
  assert.deepEqual(reactions.at(-1),{message:'om_thanks',emoji:'THANKS'})
  assert.equal(reactions.length,2,'永久准入重投不重复反馈')
  failReaction=true
  const before=p.entries().length
  await emit('om_failed_reaction','feishu-failed-reaction','怎么做？')
  assert.equal(p.entries().length,before+1,'反馈被平台拒绝不吞掉原消息')
  assert.deepEqual(reactions.at(-1),{message:'om_failed_reaction',emoji:'THINKING'})
  p.services.controls.authorize=async()=>false
  await emit('om_denied','feishu-denied','THANKS')
  assert.equal(reactions.length,3,'未授权消息不对外反馈')
  assert.equal(p.entries().length,before+1)
  const reply = await dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger', app_id: spec('feishu').credentials.appId, event_id: 'card-event' },
    event: { operator: { open_id: 'ou_member' }, action: { value: { prompt_id: 7, token: 'synthetic-action' } } } }, { needCheck: false })
  assert.ok(reply); assert.ok(p.events.includes('callback:feishu')); await connection.stop()
})
test('QQ实际WS协议/HTTP client→Core解析/预检→引用索引端口→公网验证下载→密封队列', async () => {
  const p = ports(), packets: unknown[] = [{ op: 10, d: { heartbeat_interval: 60_000 } }, { op: 0, t: 'READY', s: 1, d: { session_id: 'synthetic-session' } },
    { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'qq-event', content: '合成QQ', author: { user_openid: 'member-a' }, attachments: [{ url: 'https://cdn.example.test/image.png', filename: '合成图片.png', content_type: 'image/png' }] } }]
  const identify: unknown[] = []; let closed = false, socketSignal!: AbortSignal
  const socket: QqSocket = { packets: (async function* () { for (const packet of packets) yield packet; try { await waiting(socketSignal) } catch { /* 合成WS关闭结束迭代。 */ } })(),
    send: async packet => { identify.push(packet) }, close: async () => { closed = true } }
  const transport: ProviderTransport = { async request(input) {
    if (input.url.includes('/app/getAppAccessToken')) return response({ access_token: 'synthetic-access', expires_in: 7200 })
    if (input.url.endsWith('/gateway')) return response({ url: 'wss://api.sgroup.qq.com/websocket' })
    if (input.url.includes('cdn.example.test')) { p.order.push('download'); return response(png) }
    throw new Error('未预期的合成QQ方法')
  }, async close() {} }
  const runtime = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => p.services, sanitizeText: value => value,
    transport: () => transport, resolve: async () => [{ address: '9.9.9.9', family: 4 }], qqSocket: async (_url, signal) => { socketSignal = signal; return socket } })
  const connection = await runtime.connect(spec('qq'), new AbortController().signal)
  await until(() => p.entries().length === 1)
  assert.ok(identify.some(value => (value as { op: number }).op === 2)); assert.ok(p.events.some(event => event.startsWith('qq-index:')))
  assert.deepEqual(p.stages[0]!.bytes, png); assert.ok(p.order.indexOf('authorize') < p.order.indexOf('download'))
  assert.deepEqual(createImInboundEnvelope(secret).open({ platform: 'qq', botId: '4', ownerId: owner }, p.entries()[0]!).attachments, ['synthetic-attach-1'])
  assert.equal(createImInboundEnvelope(secret).openForWorker({ platform: 'qq', botId: '4', ownerId: owner }, p.entries()[0]!).admission, 'gateway')
  await connection.stop(); assert.equal(closed, true)
})
test('QQ附件即时确认按Bot/目标冷却、准入重投幂等及可信群策略；失败不吞原消息',async()=>{
  const p=ports(),attempts:string[]=[]
  let socketSignal!:AbortSignal,at=100000,allowed=true,failAck=false,waitingSocket=false
  const cases=[
    {id:'private-one',peer:'member-a',at:100000},
    {id:'private-one',peer:'member-a',at:100001},
    {id:'private-two',peer:'member-a',at:100002},
    {id:'private-later',peer:'member-a',at:110001},
    {id:'group-auto',peer:'member-a',group:'group-auto',at:120002,allowed:false},
    {id:'group-at',peer:'member-a',group:'group-at',at:120003},
    {id:'private-failed',peer:'member-b',at:120004,fail:true},
    {id:'private-text',peer:'member-c',at:120005,textOnly:true},
  ]
  const socket:QqSocket={send:async()=>{},close:async()=>{},packets:(async function*(){
    yield{op:10,d:{heartbeat_interval:60000}};yield{op:0,t:'READY',s:1,d:{session_id:'synthetic-ack-session'}}
    for(const [index,item]of cases.entries()){
      at=item.at;allowed=item.allowed!==false;failAck=item.fail===true
      yield{op:0,t:item.group?'GROUP_AT_MESSAGE_CREATE':'C2C_MESSAGE_CREATE',s:index+2,d:{id:item.id,content:'合成附件确认消息',
        ...(item.group?{group_openid:item.group}:{}),author:{user_openid:item.peer,member_openid:item.peer},
        attachments:item.textOnly?[]:[{url:'https://cdn.example.test/image.png',filename:'合成图片.png',content_type:'image/png'}]}}
    }
    waitingSocket=true;try{await waiting(socketSignal)}catch{/* 合成关闭。 */}
  })()}
  const transport:ProviderTransport={async request(input){
    if(input.url.includes('/app/getAppAccessToken'))return response({access_token:'synthetic-access',expires_in:7200})
    if(input.url.endsWith('/gateway'))return response({url:'wss://api.sgroup.qq.com/websocket'})
    if(input.url.includes('cdn.example.test'))return response(png)
    if(input.url.endsWith('/messages')){
      const body=JSON.parse(Buffer.from(input.body as Uint8Array).toString());assert.equal(body.markdown?.content??body.content,'文件收到啦，让我看看~')
      attempts.push(new URL(input.url).pathname)
      return failAck?response({code:40003,message:'synthetic-private-rejected'},400):response({id:`qq_ack_${attempts.length}`})
    }
    throw Error('未配置的合成QQ请求')
  }}
  const runtime=createPlatformConnections({redis:p.redis,secretKey:secret,sanitizeText:value=>value,now:()=>at,services:()=>({...p.services,qqInstantAckPolicy:async scope=>allowed?{messageFormat:scope.chatType==='group'?'compat' as const:'markdown' as const}:null}),
    transport:()=>transport,resolve:async()=>[{address:'9.9.9.9',family:4}],qqSocket:async(_url,signal)=>{socketSignal=signal;return socket}})
  const connection=await runtime.connect(spec('qq'),new AbortController().signal)
  try{
    await until(()=>waitingSocket&&p.entries().length===cases.length)
    assert.deepEqual(attempts.map(path=>path.split('/').at(-2)),['member-a','member-a','group-at','member-b'])
    assert.equal(p.entries().length,8,'冷却/静默/拒绝确认与重投均保留准入消息供正式去重处理')
  }finally{await connection.stop()}
})

test('缺失控制/媒体/平台业务服务时启动拒绝，不以空入口标记已连接', async () => {
  const p = ports()
  const runtime = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => ({ ...p.services, controls: {} as never }), sanitizeText: value => value })
  await assert.rejects(runtime.connect(spec('wechat'), new AbortController().signal), /装配未完成/)
  const qq = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => ({ ...p.services, prepareQq: undefined }), sanitizeText: value => value })
  await assert.rejects(qq.connect(spec('qq'), new AbortController().signal), /装配未完成/)
  assert.equal(p.wire.length, 0)
})
test('停止等待在途媒体暂存排空；取消后不写队列且仅释放本次创建收据', async () => {
  const p = ports(); let entered = false, complete!: () => void, polls = 0
  const original = p.services.attachments.stage
  p.services.attachments.stage = async input => { entered = true; await new Promise<void>(resolve => { complete = resolve }); return original(input) }
  const transport: ProviderTransport = { async request(input, signal) {
    if (input.url.endsWith('/getMe')) return response({ ok: true, result: { id: 99 } })
    if (input.url.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '' } })
    if (input.url.endsWith('/getUpdates') && polls++ === 0) return response({ ok: true, result: [{ update_id: 1, message: { message_id: 31, date: 100, chat: { id: 9, type: 'private' }, from: { id: 9 }, document: { file_id: 'synthetic-file', file_name: '合成.png' } } }] })
    if (input.url.endsWith('/getUpdates')) return waiting(signal)
    if (input.url.endsWith('/getFile')) return response({ ok: true, result: { file_path: 'photos/synthetic.png', file_size: png.length } })
    if (input.url.includes('/file/bot')) return response(png)
    throw new Error('未预期的合成方法')
  }, async close() {} }
  const runtime = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => p.services, sanitizeText: value => value, transport: () => transport })
  const connection = await runtime.connect(spec('telegram'), new AbortController().signal)
  await until(() => entered)
  let stopped = false
  const stopping = connection.stop().then(() => { stopped = true })
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false)
  complete(); await stopping
  assert.equal(p.entries().length, 0); assert.deepEqual(p.events.filter(event => event.startsWith('release:')), ['release:receipt-1'])
})
test('Telegram callback先交可信业务消费者，再实际ACK并清键盘只推进cursor，不入普通消息队列', async () => {
  const p = ports(); let polls = 0, ack = false,cleaned=false
  const transport: ProviderTransport = { async request(input, signal) {
    if (input.url.endsWith('/getMe')) return response({ ok: true, result: { id: 99 } })
    if (input.url.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '' } })
    if (input.url.endsWith('/getUpdates') && polls++ === 0) return response({ ok: true, result: [{ update_id: 3, callback_query: { id: 'callback-a', from: { id: 9 }, data: '7:synthetic-action', message: { message_id: 30, chat: { id: 9, type: 'private' } } } }] })
    if (input.url.endsWith('/getUpdates')) return waiting(signal)
    if (input.url.endsWith('/answerCallbackQuery')) {
      assert.ok(p.events.includes('callback:telegram'))
      assert.deepEqual(JSON.parse(Buffer.from(input.body as Uint8Array).toString()), { callback_query_id: 'callback-a', text: '已收到选择', show_alert: false })
      ack = true; return response({ ok: true, result: true })
    }
    if(input.url.endsWith('/editMessageReplyMarkup')){
      assert.equal(ack,true)
      assert.deepEqual(JSON.parse(Buffer.from(input.body as Uint8Array).toString()),{chat_id:9,message_id:30,reply_markup:{inline_keyboard:[]}})
      cleaned=true;return response({ok:true,result:true})
    }
    throw new Error('未预期的合成回调方法')
  }, async close() {} }
  const runtime = createPlatformConnections({ redis: p.redis, secretKey: secret, services: () => p.services, sanitizeText: value => value, transport: () => transport })
  const connection = await runtime.connect(spec('telegram'), new AbortController().signal)
  await until(() => ack && cleaned && p.wire.length === 1)
  assert.equal(p.entries().length, 0); assert.equal(p.stages.length, 0)
  await connection.stop()
})

test('Telegram清键盘失败仅固定诊断，重复callback正常ACK而幂等消费者不重复业务，cursor继续推进',async()=>{
  const p=ports(),seen=new Set<string>(),reports:string[]=[]
  let polls=0,business=0,acks=0,cleanups=0
  p.services.callback=async event=>{const key=String(event.data.id);if(!seen.has(key)){seen.add(key);business++}return{accepted:true,consumed:true}}
  const callback={id:'callback-repeat',from:{id:9},data:'7:synthetic-action',message:{message_id:30,chat:{id:9,type:'private'}}}
  const transport:ProviderTransport={async request(input,signal){
    if(input.url.endsWith('/getMe'))return response({ok:true,result:{id:99}})
    if(input.url.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
    if(input.url.endsWith('/getUpdates')&&polls++===0)return response({ok:true,result:[{update_id:3,callback_query:callback},{update_id:4,callback_query:callback}]})
    if(input.url.endsWith('/getUpdates'))return waiting(signal)
    if(input.url.endsWith('/answerCallbackQuery')){acks++;return response({ok:true,result:true})}
    if(input.url.endsWith('/editMessageReplyMarkup')){cleanups++;return response({ok:false,error_code:403,description:'synthetic-private-response'})}
    throw new Error('未预期的合成回调方法')
  },async close(){}}
  const runtime=createPlatformConnections({redis:p.redis,secretKey:secret,services:()=>p.services,sanitizeText:v=>v,transport:()=>transport,report:code=>reports.push(code)})
  const connection=await runtime.connect(spec('telegram'),new AbortController().signal)
  await until(()=>acks===2&&cleanups===2&&p.wire.length>=2)
  assert.equal(business,1);assert.deepEqual(reports,['callback-cleanup-pending','callback-cleanup-pending'])
  assert.equal(p.entries().length,0);assert.equal(p.stages.length,0)
  await connection.stop()
})
