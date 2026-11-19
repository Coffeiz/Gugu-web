import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { ProviderTransport } from '@gugu/core/providers'
import { createAgentRunCodec } from '@gugu/core/agent/run/codec'
import { serializeLiveMessage } from '@gugu/core/live-message'
import { createNodeImHostRuntime } from '../../../src/modules/im/gateway/bootstrap.js'
import { createRedisStreamCommands } from '../../../src/adapters/cache/redis-stream-commands.js'
import { createRedisLiveSubscription, type LiveSubscription, type LiveSubscriptionMessage } from '../../../src/adapters/cache/redis-live-subscription.js'
import { createImProductionFixture } from './production.fixtures.js'

const databaseUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL
const python = process.env.GUGU_IM_FIXTURE_PYTHON
const response = (value: unknown) => ({ status: 200, headers: {}, body: (async function* () {
  yield value instanceof Uint8Array ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
})(), cancel() {} })
function wav() {
  const bytes = Buffer.alloc(44 + 3200)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(3200, 40)
  return bytes
}
function blocked(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error('合成轮询已停止'))
    else signal.addEventListener('abort', () => reject(new Error('合成轮询已停止')), { once: true })
  })
}

for (const mode of ['asr', 'native', 'native-caption', 'native-empty', 'native-failed', 'native-batch', 'unconfigured', 'batch', 'group', 'group-batch', 'silk'] as const) test(`真实语音bootstrap/${mode}：平台文件→授权claim→生产音频分支→真实Harness→平台结果`, {
  skip: !(databaseUrl && redisUrl && python) && '需显式独占PG/Redis与离线ORM解释器', timeout: 120000,
}, async () => {
  const f = await createImProductionFixture({ python: python!, databaseUrl, platform: 'telegram' })
  const group = mode === 'group' || mode === 'group-batch', batch = mode === 'batch' || mode === 'group-batch' || mode === 'native-batch'
  const native = mode === 'native' || mode.startsWith('native-')
  const usesAsr = mode === 'asr' || batch || group || mode === 'silk' || native && mode !== 'native'
  const redis = createRedisStreamCommands(redisUrl!), transcript = '咕咕，请帮忙整理周五整理清单', answer = '已收到合成语音任务'
  let audio = wav()
  let runtime: ReturnType<typeof createNodeImHostRuntime> | undefined, previous: Set<string> | undefined
  let subscription: LiveSubscription | undefined
  let polls = 0, asrCalls = 0, mainCalls = 0, downloads = 0
  const delivered: string[] = [], diagnostics: string[] = [], requests: Record<string, unknown>[] = []
  try {
    if (mode === 'asr') {
      // 只生成合成OGG；生产路径须使用真实受控ffmpeg再转WAV，而非注入转码替身。
      const encoded = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'pipe', '-f', 'wav', '-i', 'pipe:0',
        '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { input: audio, timeout: 10000, maxBuffer: 1048576, windowsHide: true })
      assert.equal(encoded.status, 0, '隔离音频bootstrap需要真实ffmpeg的OGG编码器')
      audio = Buffer.from(encoded.stdout)
    }
    if (mode === 'silk') {
      const input=join(f.root,'synthetic.pcm'),output=join(f.root,'synthetic.silk')
      await writeFile(input,audio.subarray(44))
      const encoded=spawnSync(python!,['-c','import pilk,sys;pilk.encode(sys.argv[1],sys.argv[2],24000,tencent=True)',input,output],{timeout:10000,maxBuffer:1048576,windowsHide:true})
      assert.equal(encoded.status,0,'SILK仅在测试用参考实现编码；生产解码必须走独立受限Node进程')
      audio=await readFile(output)
    }
    const document = JSON.parse(await readFile(f.configPath, 'utf8'))
    document.ai.audio = native
    document.ai.capability_overrides = { audio: native }
    if (usesAsr) document.voice_presets = { active_id: 'synthetic-asr', items: [{ id: 'synthetic-asr', name: '合成独立ASR', provider: 'openai',
      model: 'synthetic-asr', api_format: 'openai', api_key: 'synthetic-voice-key', base_url: 'https://voice.example.test/v1' }] }
    await writeFile(f.configPath, JSON.stringify(document))
    if (group) await f.pool.query("UPDATE user_bots SET group_attention_mode='natural' WHERE user_id=$1", [f.ownerId])
    const provider: ProviderTransport = { async request(request) {
      const body = structuredClone(request.body) as Record<string, unknown>
      requests.push(body)
      if (body.model === 'synthetic-asr') {
        asrCalls++; assert.equal(request.headers.Authorization, 'Bearer synthetic-voice-key')
        assert.match(JSON.stringify(body), /input_audio/); assert.equal(body.tools, undefined)
        if (mode === 'asr' || mode === 'silk') assert.match(JSON.stringify(body), /data:audio\/wav;base64,/)
        if (mode === 'native-failed') return { ...response({ error: { message: 'synthetic-private-asr-error' } }), status: 401 }
        return response({ choices: [{ message: { content: mode === 'native-empty' ? '' : transcript } }] })
      }
      if (body.stream) {
        mainCalls++
        if (usesAsr && !native) { assert.match(JSON.stringify(body), /周五整理清单/); assert.ok(!JSON.stringify(body).includes(audio.toString('base64'))) }
        if (batch) assert.equal(JSON.stringify(body).match(/批次尾部标记/g)?.length, 1)
        if (native) { assert.match(JSON.stringify(body), /input_audio/); assert.ok(JSON.stringify(body).includes(audio.toString('base64')))
          assert.ok(!JSON.stringify(body).includes(transcript), '原生字幕仅展示卡片，不能重复注入用户正文') }
        return response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      }
      return response({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
    } }
    const platform: ProviderTransport = { async request(request, signal) {
      const path = new URL(request.url).pathname
      if (path.endsWith('/getUpdates')) {
        if (++polls === 1) return response({ ok: true, result: [{ update_id: 2200, message: { message_id: 2201,
          date: Math.floor(Date.now() / 1000), from: { id: 202, first_name: '合成人物' }, chat: { id: group ? -404 : 202, type: group ? 'group' : 'private' },
          voice: { file_id: 'synthetic-audio-id', file_unique_id: 'synthetic-audio-unique', duration: 1, mime_type: mode === 'asr' ? 'audio/ogg' : mode === 'silk' ? 'audio/silk' : 'audio/wav', file_size: audio.length } } },
          ...(batch ? [{ update_id: 2202, message: { message_id: 2203, date: Math.floor(Date.now() / 1000),
            from: { id: 202, first_name: '合成人物' }, chat: { id: group ? -404 : 202, type: group ? 'group' : 'private' }, text: '批次尾部标记' } }] : [])] })
        return blocked(signal)
      }
      if (path.endsWith('/getMe')) return response({ ok: true, result: { id: 303, username: 'synthetic_bot' } })
      if (path.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '' } })
      if (path.endsWith('/getFile')) return response({ ok: true, result: { file_path: mode === 'asr' ? 'voice/synthetic.ogg' : mode === 'silk' ? 'voice/synthetic.silk' : 'voice/synthetic.wav', file_size: audio.length } })
      if (/\/voice\/synthetic\.(wav|ogg|silk)$/.test(path)) { downloads++; return response(audio) }
      if (path.endsWith('/sendMessage')) {
        const body = JSON.parse(Buffer.from(request.body as Uint8Array).toString())
        delivered.push(body.text); return response({ ok: true, result: { message_id: 2300 + delivered.length } })
      }
      if (path.endsWith('/sendChatAction')) return response({ ok: true, result: true })
      throw new Error('未配置的合成平台请求')
    } }
    previous = new Set(await redis.sendCommand(['EVAL', 'return redis.call("KEYS","*")', '1', 'synthetic-voice-cleanup']) as string[])
    if (native && usesAsr) subscription = await createRedisLiveSubscription(redisUrl!)([`events:${f.ownerId}`, `events:${f.otherOwnerId}`])
    const createRuntime = () => createNodeImHostRuntime({ ...f, redisUrl: redisUrl!, publicAppUrl: 'https://app.example.test',
      ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true },
      mcpRuntime: { async invalidate() { throw new Error('此用例不消费MCP凭据') } }, diagnose: code => diagnostics.push(code),
      testing: { provider: { transport: provider }, intervalMs: 100,
        platform: { transport: () => platform, resolve: async () => [{ address: '11.22.33.44', family: 4 }] } } })
    runtime = createRuntime()
    await runtime.start()
    let complete = false
    for (let i = 0; i < 400; i++) {
      complete = delivered.length > 0 && (await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rows.length === 1
      if (complete) break
      await delay(50)
    }
    assert.ok(complete, JSON.stringify({ diagnostics, health: runtime.health(), asrCalls, mainCalls, downloads, delivered }))
    assert.equal(downloads, 1)
    assert.equal((await f.pool.query("SELECT 1 FROM chat_attachments WHERE state='attached'")).rows.length, 1)
    if (mode === 'unconfigured') {
      assert.equal(asrCalls, 0); assert.equal(mainCalls, 0)
      assert.match(delivered.join('\n'), /不能处理语音/)
    } else {
      assert.equal(asrCalls, usesAsr ? 1 : 0); assert.equal(mainCalls, 1)
      assert.match(delivered.join('\n'), /合成语音任务/)
    }
    if (usesAsr) {
      const messages = (await f.pool.query("SELECT files FROM conversation_messages WHERE role='user' ORDER BY conversation_seq")).rows
      const card = messages.flatMap(message => message.files ?? []).find(card => card.kind === 'voice')
      assert.equal(card?.transcript_status, mode === 'native-failed' ? 'failed' : mode === 'native-empty' ? 'empty' : 'completed')
      assert.equal(card?.transcript_scope, 'message')
      assert.equal(card?.transcript, mode === 'native-failed' || mode === 'native-empty' ? undefined : transcript)
    }
    if (subscription) {
      let updated: { message_id: number; files: Array<Record<string, unknown>> } | undefined
      for (let i = 0; i < 100 && !updated; i++) {
        const event: LiveSubscriptionMessage | null = await subscription.next(AbortSignal.timeout(2000)); assert.ok(event)
        assert.equal(event.channel, `events:${f.ownerId}`, '字幕只能发给可信owner频道')
        const value = JSON.parse(event.data)
        if (value.resource === 'sessions' && value.operation === 'update' && value.payload?.message_update) {
          assert.ok(serializeLiveMessage(event.data), '正式Core live协议必须接受字幕事件')
          assert.equal(typeof value.entity_id, 'number'); updated = value.payload.message_update
        }
      }
      assert.ok(updated, '正式Redis须出现提交后的轻量字幕message_update')
      const persisted = (await f.pool.query('SELECT files FROM conversation_messages WHERE id=$1 AND role=$2', [updated.message_id, 'user'])).rows[0]?.files
      assert.ok(persisted); const card = updated.files.find(card => card.kind === 'voice')!
      assert.equal(card.transcript_status, mode === 'native-failed' ? 'failed' : mode === 'native-empty' ? 'empty' : 'completed')
      assert.equal(card.transcript, mode === 'native-failed' || mode === 'native-empty' ? undefined : transcript)
      assert.ok(!JSON.stringify(updated).match(/storage_key|im_ingress|sealed_payload|context_token|"extra"/u), '公开事件不含存储或平台内部材料')
    }
    if (group) {
      const cached = (await f.pool.query('SELECT state,sealed_result FROM gugu_im_voice_cache')).rows
      assert.equal(cached.length, 1); assert.equal(cached[0].state, 'completed')
      assert.ok(!cached[0].sealed_result.includes(Buffer.from(transcript)))
      assert.equal((await f.pool.query('SELECT 1 FROM gugu_im_voice_run_bindings')).rowCount, 1)
      const raw = (await f.pool.query('SELECT sealed_payload FROM gugu_im_inbound_receipts')).rows
      assert.ok(!JSON.stringify(raw).includes(transcript), '注意力转写不能改变原始消息密封事实')
      await runtime.stop()
      const sentBefore = delivered.length
      polls = 0; runtime = createRuntime(); await runtime.start()
      for (let i = 0; i < 100 && polls === 0; i++) await delay(50)
      assert.ok(polls > 0, '新实例必须真正重新连接平台')
      await delay(1200)
      assert.equal(asrCalls, 1, '重启重投不得再次识别语音')
      assert.equal(mainCalls, 1, '重启重投不得再次运行Agent')
      assert.equal(delivered.length, sentBefore, '重复事件不得重复回复')
    }
    const row = (await f.pool.query('SELECT user_id,session_id,run_id,version,nonce,payload FROM agent_run_checkpoints')).rows[0]
    const checkpoint = createAgentRunCodec(f.secretKey).decryptCheckpoint({ ownerId: row.user_id, sessionId: String(row.session_id), runId: row.run_id }, Number(row.version), row.nonce, row.payload)
    assert.ok(!JSON.stringify(checkpoint).includes(audio.toString('base64')), '正式checkpoint必须只保留授权稳定引用')
  } finally {
    try { await runtime?.stop() } finally {
      if (previous) {
        const own = (await redis.sendCommand(['EVAL', 'return redis.call("KEYS","*")', '1', 'synthetic-voice-cleanup']) as string[]).filter(key => !previous!.has(key))
        for (const key of own) await redis.sendCommand(['EVAL', 'return redis.call("DEL",KEYS[1])', '1', key])
      }
      await subscription?.close(); await redis.close(); await f.close()
    }
  }
})
