import assert from 'node:assert/strict'
import { Agent } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { ProviderTransport } from '@gugu/core/providers'
import { createNodeImHostRuntime } from '../../../src/modules/im/gateway/bootstrap.js'
import { createRedisStreamCommands } from '../../../src/adapters/cache/redis-stream-commands.js'
import { createRedisLiveSubscription, type LiveSubscription } from '../../../src/adapters/cache/redis-live-subscription.js'
import { createLocalPreferenceTextFiles } from '../../../src/modules/preferences/persistence/personality-files.js'
import { createImProductionFixture } from './production.fixtures.js'

const databaseUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL
const python = process.env.GUGU_IM_FIXTURE_PYTHON ?? process.env.GUGU_IM_ORM_PYTHON
const response = (value: unknown, status = 200) => ({ status, headers: {}, body: (async function* () {
  yield Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
})(), cancel() {} })
function blocked(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error('合成网络已停止'))
    else signal.addEventListener('abort', () => reject(new Error('合成网络已停止')), { once: true })
  })
}
async function until(check: () => Promise<boolean>, diagnostics: () => unknown, attempts=300) {
  for (let i = 0; i < attempts; i++) { if (await check()) return; await delay(50) }
  assert.fail(`正式链路未完成：${JSON.stringify(await diagnostics())}`)
}

const bootstrapCases:Array<{platform:'telegram'|'qq'|'wechat'|'feishu';privateStreaming?:boolean;chart?:boolean;flip?:boolean;plainFlip?:boolean;streamRejected?:boolean;group?:boolean}>=[
  ...(['telegram','qq','wechat','feishu'] as const).map(platform=>({platform})),
  {platform:'feishu',group:true},
  {platform:'qq',privateStreaming:true},
  {platform:'qq',privateStreaming:true,chart:true},
  {platform:'qq',privateStreaming:true,flip:true},
  {platform:'qq',plainFlip:true},
  {platform:'qq',privateStreaming:true,streamRejected:true},
]
for (const {platform,privateStreaming=false,chart=false,flip=false,plainFlip=false,streamRejected=false,group=false} of bootstrapCases) test(`${platform}${group?'群聊':''}${privateStreaming?'私聊流式':''}${chart?'真实图表':''}${flip?'开关切换':''}${plainFlip?'普通转流式':''}${streamRejected?'零受理回退':''} 正式bootstrap：真实准入/队列/生产资源/Harness/出站；重启重投不再Run`, {
  skip: !(databaseUrl && redisUrl && python) && '需专属隔离Redis、PG及离线ORM解释器', timeout: 120000,
}, async () => {
  const f = await createImProductionFixture({ python: python!, databaseUrl, platform })
  const redis = createRedisStreamCommands(redisUrl!), diagnostics: string[] = [], requests: Record<string, unknown>[] = []
  const ownerPlatformId = platform === 'telegram' ? '202' : platform === 'feishu' ? 'ou_synthetic' : 'synthetic-owner'
  await f.pool.query('UPDATE user_bots SET owner_platform_user_id=$1,app_id=$2,private_streaming_enabled=$4 WHERE id=$3',
    [ownerPlatformId, platform === 'wechat' ? 'https://ilinkai.weixin.qq.com' : platform === 'feishu' ? 'cli_0123456789abcdef' : 'synthetic-app', f.botId,privateStreaming])
  const question = '请回答合成生产入口问题', answer = chart?'图前\n```mermaid\nflowchart LR; A --> B\n```\n图后':'已完成合成生产入口回答'+(privateStreaming?'\n':'')
  const streamFrames:Record<string,unknown>[]=[],drafts:Record<string,unknown>[]=[]
  const chartBytes:Buffer[]=[],mediaMessages:Record<string,unknown>[]=[],plainMessages:Record<string,unknown>[]=[]
  let flipped=false,streamAttempts=0
  const persona = '合成来源快照：请始终称呼当前用户为小北。'
  await createLocalPreferenceTextFiles(f.storageRoot).write(f.ownerId, 'personality', persona)
  await f.insert('user_preferences', { user_id: f.ownerId, data_json: JSON.stringify({ personality_preference_enabled: true, ...(plainFlip ? { show_intermediate_replies: true } : {}) }) })
  if(plainFlip)await f.pool.query(`CREATE FUNCTION reject_plain_cursor() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    IF NEW.cursor>OLD.cursor AND EXISTS(SELECT 1 FROM gugu_im_delivery_receipts r WHERE r.user_id=NEW.user_id AND r.session_id=NEW.session_id
      AND r.run_id=NEW.run_id AND r.delivery_key LIKE 'round:%:text' AND r.state='accepted') THEN RAISE EXCEPTION 'synthetic-cursor-fault';END IF;
    RETURN NEW;END$$; CREATE TRIGGER reject_plain_cursor BEFORE UPDATE ON gugu_im_run_delivery FOR EACH ROW EXECUTE FUNCTION reject_plain_cursor()`)
  let cardKitCreates = 0
  let sent = 0, starts = 0, runtime: ReturnType<typeof createNodeImHostRuntime> | undefined
  let rejectDelivery = platform === 'telegram'
  const probeMcpSchema = (platform === 'qq' && !privateStreaming && !plainFlip) || group
  let requestedMcpSchema = false
  let forwardedTime = false
  // 仅平台HTTP/WS和Provider网络为替身；业务source、模型绑定、授权、Redis、PG、Harness均实际运行。
  const provider: ProviderTransport = { async request(request) {
    const body = typeof request.body === 'string' || request.body instanceof Uint8Array
      ? JSON.parse(Buffer.from(request.body).toString()) : structuredClone(request.body) as Record<string, unknown>
    requests.push(body)
    if (probeMcpSchema && body.stream && !requestedMcpSchema) {
      requestedMcpSchema = true
      const call = { index: 0, id: 'mcp_schema_probe', type: 'function', function: {
        name: 'search_tools', arguments: JSON.stringify({ names: ['manage_mcp_servers'] }),
      } }
      return response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
    }
    if (probeMcpSchema && !group && body.stream && !forwardedTime) {
      forwardedTime = true
      const call = { index: 0, id: 'forwarded_time', type: 'function', function: {
        name: 'call_tool', arguments: JSON.stringify({ tool_name: 'get_current_time', arguments: {} }),
      } }
      return response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
    }
    return response(body.stream ? `data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      : { choices: [{ message: { content: '合成摘要' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
  }, async close() {} }
  const make = () => {
    let polls = 0, socketSignal!: AbortSignal
    const transport: ProviderTransport = { async request(request, signal) {
      const url = new URL(request.url), path = url.pathname
      if (path.includes('/getUpdates')) {
        if (++polls === 1) return response({ ok: true, result: [{ update_id: 100, message: { message_id: 101, date: Math.floor(Date.now() / 1000),
          chat: { id: 202, type: 'private' }, from: { id: 202, first_name: '合成人物' }, text: question } }] })
        return blocked(signal)
      }
      if (path.endsWith('/getMe')) return response({ ok: true, result: { id: 303, username: 'synthetic_bot' } })
      if (path.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '' } })
      if(path.endsWith('/sendMessageDraft')){drafts.push(JSON.parse(Buffer.from(request.body as Uint8Array).toString()));return response({ok:true,result:true})}
      if (path.endsWith('/sendMessage')) {
        if (rejectDelivery) return response({ ok: false, error_code: 403, description: '合成明确拒绝' }, 403)
        sent++; return response(platform === 'telegram' ? { ok: true, result: { message_id: 900 + sent } } : { ret: 0 })
      }
      if (path.endsWith('/getupdates')) {
        if (++polls === 1) return response({ ret: 0, get_updates_buf: 'synthetic-cursor', msgs: [{ message_id: 'wx_101', message_type: 1,
          from_user_id: ownerPlatformId, context_token: 'synthetic-route-token', item_list: [{ type: 1, text_item: { text: question } }] }] })
        return blocked(signal)
      }
      if (path.endsWith('/getconfig')) return response({ ret: 0 })
      if (path.endsWith('/sendmessage')) { sent++; const body = JSON.parse(Buffer.from(request.body as Uint8Array).toString()); assert.equal(body.msg.context_token, 'synthetic-route-token'); return response({ ret: 0 }) }
      if (path.endsWith('/notifystart') || path.endsWith('/notifystop')) return response({ ret: 0 })
      if (path.endsWith('/app/getAppAccessToken')) return response({ access_token: 'synthetic-access', expires_in: 7200 })
      if (path.endsWith('/gateway')) return response({ url: 'wss://api.sgroup.qq.com/websocket' })
      if(platform==='qq'&&path.endsWith('/upload_prepare')){
        assert.equal(chart,true)
        return response({upload_id:'synthetic-chart-upload',block_size:3*1024*1024,parts:[{index:1,presigned_url:'https://synthetic.cos.myqcloud.com/part?synthetic=true'}]})
      }
      if(platform==='qq'&&new URL(request.url).hostname==='synthetic.cos.myqcloud.com'){
        chartBytes.push(Buffer.from(request.body as Uint8Array));return response('')
      }
      if(platform==='qq'&&path.endsWith('/upload_part_finish'))return response({})
      if(platform==='qq'&&path.endsWith('/files'))return response({file_info:'synthetic-chart-file-info'})
      if (platform === 'qq' && /\/v2\/users\/[^/]+\/messages$/u.test(path)) {
        const body=JSON.parse(Buffer.from(request.body as Uint8Array).toString())
        if(body.msg_type===7)mediaMessages.push(body)
        else plainMessages.push(body)
        if(plainFlip&&!flipped){await f.pool.query('UPDATE user_bots SET private_streaming_enabled=true WHERE id=$1',[f.botId]);flipped=true}
        sent++; return response({ id: `qq_out_${sent}` })
      }
      if(platform==='qq'&&path.endsWith('/stream_messages')){
        streamAttempts++
        assert.equal(privateStreaming,true,'关闭开关不得请求流式API')
        const frame=JSON.parse(Buffer.from(request.body as Uint8Array).toString());streamFrames.push(frame)
        if(streamRejected)return response({code:40034031,message:'synthetic-expired-passive'},400)
        if(flip&&frame.input_state===1&&!flipped){await f.pool.query('UPDATE user_bots SET private_streaming_enabled=false WHERE id=$1',[f.botId]);flipped=true}
        if(frame.input_state===10)sent++
        return response({id:chart?`qq_stream_${frame.msg_seq}`:'qq_stream_out'})
      }
      if (path.includes('/tenant_access_token/')) return response({ code: 0, tenant_access_token: 'synthetic-feishu-access', expire: 7200 })
      if (path.endsWith('/bot/v3/info')) return response({ code: 0, data: { bot: { open_id: 'ou_bot' } } })
      if (platform === 'feishu' && path.endsWith('/cards')) { cardKitCreates++; return response({ code: 0, data: { card_id: 'card_synthetic' } }) }
      if (platform === 'feishu' && path.endsWith('/messages')) { sent++; return response({ code: 0, data: { message_id: `om_out_${sent}` } }) }
      if (platform === 'feishu' && path.includes('/cardkit/')) return response({ code: 0 })
      if (path.endsWith('/callback/ws/endpoint')) return response({ code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/ws/v2?ticket=synthetic', ClientConfig: {} } })
      throw new Error(`未配置的合成平台路径：${path}`)
    }, async close() {} }
    return createNodeImHostRuntime({ ...f, redisUrl: redisUrl!, publicAppUrl: 'https://app.example.test',
      ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true },
      mcpRuntime: {
        async invalidate() { throw new Error('此用例不消费MCP凭据') },
        state: (_ownerId, id) => ({ server_id: id, state: 'unloaded', loaded_tool_count: 0, loaded_tool_names: [], last_error: null }),
        async testConnection() { return { ok: true, toolNames: [] } },
      }, diagnose: code => diagnostics.push(code),
      testing: { provider: { transport: provider }, intervalMs: 100,
        platform: { transport: () => transport, resolve: async () => [{ address: '9.9.9.9', family: 4 }],
          qqSocket: async (_url, signal) => { socketSignal = signal; return { send: async () => {}, close: async () => {},
            packets: (async function* () { yield { op: 10, d: { heartbeat_interval: 60000 } }; yield { op: 0, t: 'READY', s: 1, d: { session_id: 'synthetic-session' } }
              yield { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'qq_101', message_scene: { ext: ['msg_idx=qq_reference_index'] }, content: question, author: { user_openid: ownerPlatformId }, timestamp: new Date().toISOString() } }
              try { await blocked(socketSignal) } catch { /* 合成WS取消结束。 */ } })() } },
          feishuNetwork: () => { const agent = new Agent(); return { agent, validateEndpoint: async () => {}, close: async () => agent.destroy() } },
          createFeishuSdk: config => ({ async start({ eventDispatcher }) { config.onReady!(); starts++;
            await eventDispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', app_id: 'cli_0123456789abcdef', create_time: String(Date.now()), event_id: 'fs_event_101' },
              event: { sender: { sender_type: 'user', sender_id: { open_id: ownerPlatformId } }, message: { message_id: 'om_input', chat_id: group ? 'oc_group' : 'oc_private', chat_type: group ? 'group' : 'p2p', message_type: 'text', content: JSON.stringify({ text: group ? `@_user_1 ${question}` : question }), mentions: group ? [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '合成机器人' }] : [] } } }, { needCheck: false })
          }, close() {} }),
        } },
    })
  }
  let previousKeys: Set<string> | undefined
  let live: LiveSubscription | undefined
  try {
    previousKeys = new Set((await redis.sendCommand(['EVAL', 'return redis.call("KEYS","*")', '1', 'gugu:bootstrap:cleanup'])) as string[])
    live = await createRedisLiveSubscription(redisUrl!)([`events:${f.ownerId}`])
    runtime = make(); await runtime.start()
    await until(async () => (await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount! > 0
      && (plainFlip?flipped&&sent===1:flip?flipped&&streamFrames.length===1:platform === 'telegram' ? (await f.pool.query("SELECT 1 FROM gugu_im_delivery_receipts WHERE state='rejected'")).rowCount! > 0
        : sent > 0 && (await f.pool.query('SELECT 1 FROM gugu_im_accepted_delivery_facts WHERE final_event_sequence IS NOT NULL')).rowCount! > 0),
      async () => ({ diagnostics, health: runtime!.health(), sent, requests: requests.length,
        dispatch: (await f.pool.query('SELECT state,blocked_reason FROM agent_run_dispatch')).rows,
        checkpoints: (await f.pool.query('SELECT status FROM agent_run_checkpoints')).rows }),chart?900:300)
    const primary = requests.find(body => JSON.stringify(body).includes(question))
    assert.ok(primary, 'Provider必须看到实际原始入站正文')
    if (probeMcpSchema) {
      const result = requests.filter(body => body.stream).flatMap(body =>
        body.messages as { role: string; tool_call_id?: string; content?: string }[]).find(message =>
        message.role === 'tool' && message.tool_call_id === 'mcp_schema_probe')
      assert.ok(result?.content)
      const schema = JSON.parse(result.content)
      if (group) assert.deepEqual(schema.rejected, ['manage_mcp_servers'])
      else {
        assert.deepEqual(schema.tool_schemas, ['manage_mcp_servers'])
        const forwarded = requests.filter(body => body.stream).flatMap(body =>
          body.messages as { role: string; tool_call_id?: string; content?: string }[]).find(message =>
          message.role === 'tool' && message.tool_call_id === 'forwarded_time')
        assert.ok(forwarded?.content)
        assert.equal(JSON.parse(forwarded.content).timezone, 'UTC')
      }
    }
    const sessionId = (await f.pool.query('SELECT id FROM conversation_sessions')).rows[0]?.id
    assert.ok(sessionId)
    const liveSignal = AbortSignal.timeout(5000)
    const operations = new Set<string>()
    while (operations.size < 2) {
      const message = await live.next(liveSignal)
      assert.ok(message)
      const change = JSON.parse(message.data)
      if (change.resource !== 'sessions' || change.payload?.messages_changed !== true) continue
      assert.equal(String(change.entity_id), String(sessionId))
      assert.deepEqual(change.payload, { messages_changed: true })
      operations.add(change.operation)
    }
    assert.deepEqual([...operations], ['update', 'refresh'])
    if (!group) assert.ok(JSON.stringify(primary!.messages).includes(persona), '必须装配当前owner真实本地persona来源快照')
    const tools = (primary!.tools as { function: { name: string } }[] ?? []).map(tool => tool.function.name)
    assert.deepEqual(tools.filter(name => name !== 'choose_no_reply'), ['call_tool', 'search_tools', 'use_skill', 'ask_user'])
    const catalog = JSON.stringify(primary!.messages)
    if (!group) assert.equal(catalog.includes('`react`'), platform === 'feishu')
    if (probeMcpSchema) {
      for (const name of ['get_project', 'list_events', 'get_upcoming', 'get_dashboard_stats', 'note_search', 'canvas_list']) {
        assert.equal(catalog.includes(`\`${name}\``), !group, `IM 工具授权：${name}`)
      }
    }
    if(group){
      assert.equal(cardKitCreates,0)
      assert.equal(sent,1)
      assert.equal((await f.pool.query("SELECT 1 FROM gugu_im_platform_projection WHERE platform='feishu'")).rowCount,0)
    }
    if(privateStreaming&&!chart&&!flip&&!streamRejected){
      assert.ok(streamFrames.length>=2)
      assert.equal(streamFrames[0]!.input_state,1);assert.equal(streamFrames.at(-1)!.input_state,10)
      assert.deepEqual(streamFrames.map(frame=>frame.index),streamFrames.map((_frame,index)=>index))
      assert.ok(streamFrames.every(frame=>frame.msg_seq===streamFrames[0]!.msg_seq))
      assert.equal(streamFrames.at(-1)!.stream_msg_id,'qq_stream_out')
    }
    if(platform==='qq'&&!privateStreaming)assert.equal(plainMessages[0]?.msg_id,'qq_101')
    if(platform==='telegram')assert.ok(drafts.length>0,'真实Run token须经生产draft入口')
    if(streamRejected){
      assert.equal(streamAttempts,1);assert.equal(streamFrames.length,1)
      assert.equal(plainMessages.length,1);assert.equal(plainMessages[0]!.msg_id,undefined,'明确过期回退须主动发送，不复用失效msg_id')
      assert.match(JSON.stringify(plainMessages[0]),/已完成合成生产入口回答/)
    }
    if(chart){
      assert.equal(chartBytes.length,1,'真实Run图表经正式uploader发送一次')
      assert.deepEqual(chartBytes[0]!.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]))
      assert.equal(mediaMessages.length,1);assert.equal((mediaMessages[0]!.media as Record<string,unknown>).file_info,'synthetic-chart-file-info')
      const closed=streamFrames.filter(frame=>frame.input_state===10)
      assert.equal(closed.length,2,'图前图后各关闭一段，不补发最终全文')
      assert.match(String(closed[0]!.content_raw),/图前/);assert.match(String(closed[1]!.content_raw),/图后/)
      assert.equal(closed.some(frame=>/```|flowchart/.test(String(frame.content_raw))),false)
    }
    const before = (await f.pool.query('SELECT count(*)::integer AS n FROM agent_run_dispatch')).rows[0].n
    assert.equal(before, 1)
    await runtime.stop(); const sentBefore = sent, requestsBefore = requests.filter(body => !!body.stream).length
    if(plainFlip)await f.pool.query('DROP TRIGGER reject_plain_cursor ON gugu_im_run_delivery; DROP FUNCTION reject_plain_cursor()')
    rejectDelivery = false
    runtime = make(); await runtime.start()
    if (platform === 'telegram') await until(async () => (await f.pool.query('SELECT 1 FROM gugu_im_accepted_delivery_facts WHERE final_event_sequence IS NOT NULL')).rowCount! > 0,
      () => ({ diagnostics, health: runtime!.health(), sent }))
    await delay(1500)
    assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM agent_run_dispatch')).rows[0].n, before)
    assert.equal(sent, sentBefore + (platform === 'telegram' ? 1 : 0), '重投不重发；明确失败的原outbox由恢复扫描实际送达')
    assert.equal(requests.filter(body => !!body.stream).length, requestsBefore, '出站恢复不能重跑Agent或重新调用Provider')
    if(flip){
      assert.equal(sent,0,'流式已确认前缀后关闭开关，不得退回普通消息重发全文')
      assert.equal(streamFrames.length,1)
      await runtime.stop();await f.pool.query('UPDATE user_bots SET private_streaming_enabled=true WHERE id=$1',[f.botId])
      runtime=make();await runtime.start()
      await until(async()=>sent===1&&(await f.pool.query('SELECT 1 FROM gugu_im_accepted_delivery_facts WHERE final_event_sequence IS NOT NULL')).rowCount!>0,
        ()=>({diagnostics,frames:streamFrames.length,sent,health:runtime!.health()}))
      assert.equal(requests.filter(body=>!!body.stream).length,requestsBefore)
      assert.equal(streamFrames.length,2);assert.equal(streamFrames[1]!.input_state,10)
      assert.equal(streamFrames[1]!.index,1);assert.equal(streamFrames[1]!.msg_seq,streamFrames[0]!.msg_seq)
      assert.equal(streamFrames[1]!.stream_msg_id,'qq_stream_out')
    }
    if(plainFlip){
      assert.equal(streamAttempts,0,'普通正文已接受后启用流式，不能另开流重发')
      await runtime.stop();await f.pool.query('UPDATE user_bots SET private_streaming_enabled=false WHERE id=$1',[f.botId])
      runtime=make();await runtime.start()
      await until(async()=>(await f.pool.query('SELECT 1 FROM gugu_im_accepted_delivery_facts WHERE final_event_sequence IS NOT NULL')).rowCount!>0,
        ()=>({diagnostics,sent,streamAttempts,health:runtime!.health()}))
      assert.equal(sent,1);assert.equal(streamAttempts,0);assert.equal(requests.filter(body=>!!body.stream).length,requestsBefore)
    }
    if (platform === 'feishu') assert.equal(starts, 2)
    await f.pool.query('UPDATE user_bots SET enabled=false WHERE id=$1', [f.botId])
    await f.pool.query("SELECT pg_notify('im_gateway_reload','')")
    await until(async () => (runtime!.health().supervisor as { running: number }).running === 0,
      () => ({ diagnostics, health: runtime!.health() }))
    assert.equal(requests.filter(body => !!body.stream).length, requestsBefore, '可信停用通知关闭连接后不可重派发')
  } finally {
    try {
      await runtime?.stop()
      if (previousKeys) {
        const ownKeys = ((await redis.sendCommand(['EVAL', 'return redis.call("KEYS","*")', '1', 'gugu:bootstrap:cleanup'])) as string[]).filter(key => !previousKeys!.has(key))
        for (let i = 0; i < ownKeys.length; i += 64) {
          const keys = ownKeys.slice(i, i + 64)
          await redis.sendCommand(['EVAL', 'return redis.call("DEL",unpack(KEYS))', String(keys.length), ...keys])
        }
      }
    } finally {
      await live?.close(); await redis.close(); await f.close()
    }
  }
})
