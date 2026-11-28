import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { adapterFor, providerSelection, ProviderError, VendorMediaError, responsesDriver, type AsrDependencies, type ProviderConfig, type ProviderHttpRequest, type ProviderTransport } from '@gugu/core/providers'
import { createImVoiceSelection } from '../../../../../src/modules/im/gateway/media/config.js'
import { createImVoiceRuntime, createImVoiceTranscriber, ImVoiceRuntimeError } from '../../../../../src/modules/im/gateway/media/voice.js'
import type { ImAudioInput } from '../../../../../src/modules/im/gateway/inbound/message.js'
import { ImAudioCleanupError } from '@gugu/gateway/media'
import { ImVoiceCacheError } from '../../../../../src/modules/im/gateway/media/cache.js'

const owner = '00000000-0000-4000-8000-000000000091'
const input: ImAudioInput = { bytes: Buffer.from('RIFFsyntheticWAVEinput'), mime: 'audio/wav', ext: 'wav', duration: 1, attachId: 'synthetic-audio' }
const emptyPool = { query: async () => ({ rows: [] }) } as unknown as Pick<Pool, 'query'>
const response = (value: unknown, status = 200) => ({ status, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(value)) })(), cancel() {} })
const textMain: ProviderConfig = { provider: 'openai', model: 'synthetic-chat', audio: false }
function fixture(format = 'openai') {
  let allowed = true, key = 'synthetic-asr-key', configured = true
  const diagnostics: string[] = []
  const voice = createImVoiceSelection({ pool: emptyPool, environment: { BYOK__ENABLED: 'false' }, authorize: async () => allowed,
    document: () => ({ voice_presets: { active_id: configured ? 'voice' : '', items: [{ id: 'voice', name: '合成识别', model: format === 'minimax-asr' ? 'asr-1.0' : 'synthetic-asr',
      api_key: key, provider: format === 'minimax-asr' ? 'minimax' : 'qwen', api_format: format,
      base_url: format === 'minimax-asr' ? 'https://api.minimax.cn' : format === 'dashscope'
        ? 'https://dashscope.example.test/api/v1/services/aigc/multimodal-generation/generation' : 'https://asr.example.test/v1' }] } }) })
  return { voice, diagnostics, authorize: async () => allowed, deny() { allowed = false }, change() { key = 'synthetic-new-key' }, unconfigure() { configured = false } }
}
const audio: Pick<AsrDependencies, 'toWav' | 'probeAudioDuration'> = { toWav: async () => Buffer.from('converted-wav'), probeAudioDuration: async () => 1 }

for (const format of ['openai', 'dashscope', 'minimax-asr']) test(`${format}转写按Python空白规则去除NEL/分隔符并保留真实BOM正文`, async () => {
  const f = fixture(format), text = '\u001c\u0085 \uFEFF合成识别\u0085'
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain,
    authorize: f.authorize, audio, diagnose: code => f.diagnostics.push(code), provider: { transport: { async request() {
      return response(format === 'minimax-asr' ? { text, base_resp: { status_code: 0 } }
        : format === 'dashscope' ? { output: { text } } : { choices: [{ message: { content: text } }] })
    } } } })
  assert.equal(await runtime.transcribe(input), '\uFEFF合成识别')
})

for (const format of ['openai', 'dashscope', 'minimax-asr']) test(`${format}实际Core ASR驱动接独立可信voice配置，输入正文/主模型key不混入请求`, async () => {
  const f = fixture(format), requests: ProviderHttpRequest[] = []; let closed = 0, multipart = ''
  const transport: ProviderTransport = { async request(request) {
    requests.push(request)
    if (format === 'minimax-asr') {
      for await (const chunk of request.body as AsyncIterable<Uint8Array>) multipart += Buffer.from(chunk).toString()
      return response({ text: ' 合成识别结果 ', base_resp: { status_code: 0 } })
    }
    return response(format === 'dashscope' ? { output: { text: ' 合成识别结果 ' } } : { choices: [{ message: { content: ' 合成识别结果 ' } }] })
  }, async close() { closed++ } }
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: { ...textMain, api_key: 'synthetic-main-key' },
    authorize: f.authorize, provider: { transport }, audio, diagnose: code => f.diagnostics.push(code) })
  assert.equal(await runtime.transcribe(input), '合成识别结果'); assert.equal(requests.length, 1)
  assert.equal(requests[0]!.headers?.Authorization, 'Bearer synthetic-asr-key')
  assert.ok(!JSON.stringify(requests).includes('synthetic-main-key'))
  if (format === 'minimax-asr') { assert.match(multipart, /audio\.wav/u); assert.match(multipart, /asr-1\.0/u) }
  else { assert.ok(!Object.hasOwn(requests[0]!.body as object, 'tools')); assert.ok(!Object.hasOwn(requests[0]!.body as object, 'thinking')) }
  assert.equal(closed, 0, '外部共享transport不归语音runtime关闭')
})

test('未配置返回null与有效空识别返回空串不同，不以空主模型配置冒充独立ASR', async () => {
  const f = fixture(); f.unconfigure(); let calls = 0
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain, authorize: f.authorize,
    provider: { transport: { async request() { calls++; return response({ choices: [{ message: { content: '' } }] }) } } }, audio, diagnose: code => f.diagnostics.push(code) })
  assert.equal(await runtime.transcribe(input), null); assert.equal(calls, 0)
  const enabled = fixture()
  const recognized = createImVoiceRuntime({ ownerId: owner, voice: enabled.voice, mainConfig: textMain, authorize: enabled.authorize,
    provider: { transport: { async request() { calls++; return response({ choices: [{ message: { content: '' } }] }) } } }, audio, diagnose() {} })
  assert.equal(await recognized.transcribe(input), ''); assert.equal(calls, 1)
})

test('兼容ASR瞬时错误有限重试，每次HTTP前核当前配置；退避期间换key后不发送第二次', async () => {
  const f = fixture(); let calls = 0, sleeps = 0
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain, authorize: f.authorize, audio,
    provider: { clock: { now: () => 0, async sleep() { sleeps++; f.change() } }, transport: { async request() { calls++; return response({ error: 'synthetic-private' }, 503) } } }, diagnose: code => f.diagnostics.push(code) })
  await assert.rejects(runtime.transcribe(input), error => error instanceof ImVoiceRuntimeError && error.code === 'unauthorized')
  assert.equal(calls, 1); assert.equal(sleeps, 1)
  const stable = fixture(); let retried = 0
  const success = createImVoiceRuntime({ ownerId: owner, voice: stable.voice, mainConfig: textMain, authorize: stable.authorize, audio,
    provider: { clock: { now: () => 0, async sleep() {} }, transport: { async request() { return ++retried < 3 ? response({}, 429) : response({ choices: [{ message: { content: '重试成功' } }] }) } } }, diagnose() {} })
  assert.equal(await success.transcribe(input), '重试成功'); assert.equal(retried, 3)
})

test('转码期间撤权及响应正文期间换配置均拒绝，不能被Core普通转写失败语义变成空识别', async () => {
  const f = fixture(); let calls = 0
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain, authorize: f.authorize,
    provider: { transport: { async request() { calls++; return response({}) } } },
    audio: { ...audio, async toWav() { f.deny(); return Buffer.from('wav') } }, diagnose() {} })
  await assert.rejects(runtime.transcribe({ ...input, mime: 'audio/ogg', ext: 'ogg' }), /授权/u); assert.equal(calls, 0)
  const changed = fixture(); let cancelled = 0
  const after = createImVoiceRuntime({ ownerId: owner, voice: changed.voice, mainConfig: textMain, authorize: changed.authorize, audio,
    provider: { transport: { async request() { return { status: 200, headers: {}, body: (async function* () {
      changed.change(); yield Buffer.from(JSON.stringify({ choices: [{ message: { content: '禁止交付旧结果' } }] }))
    })(), cancel() { cancelled++ } } } } }, diagnose() {} })
  await assert.rejects(after.transcribe(input), /授权/u); assert.equal(cancelled, 1)
})

test('普通识别失败固定诊断并空串，MiniMax明确HTTP/业务码错误保留raise_minimax_errors且不暴露正文', async () => {
  for (const format of ['openai', 'minimax-asr']) {
    const f = fixture(format)
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain, authorize: f.authorize, audio,
      provider: { transport: { async request() { return response({ error: { message: 'synthetic-private-response-token' } }, 401) } } }, diagnose: code => f.diagnostics.push(code) })
    if (format === 'openai') assert.equal(await runtime.transcribe(input), '')
    else await assert.rejects(runtime.transcribe(input), error => error instanceof ProviderError && error.options.status === 401
      && !JSON.stringify(error).includes('synthetic-private'))
    assert.ok(f.diagnostics.every(code => code === 'im_voice_failed'))
    assert.ok(f.diagnostics.length > 0)
  }
  const f = fixture('minimax-asr')
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain, authorize: f.authorize, audio,
    provider: { transport: { async request() { return response({ base_resp: { status_code: 1004, status_msg: 'synthetic-private' } }) } } }, diagnose() {} })
  await assert.rejects(runtime.transcribe(input), error => error instanceof ProviderError && error.code === 'upstream')
})

test('自建factory/createTransport仅关闭自己的实例，成功/失败/取消均释放且外部取消原因不泄露', async () => {
  for (const factory of [false, true]) for (const mode of ['success', 'failed', 'cancelled']) {
    const f = fixture(), controller = new AbortController(); let closed = 0
    const create = () => ({ async request() {
      if (mode === 'cancelled') { controller.abort('synthetic-private-cancel'); throw new Error('synthetic-private-network') }
      return mode === 'failed' ? response({}, 401) : response({ choices: [{ message: { content: '成功' } }] })
    }, async close() { closed++ } })
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain, authorize: f.authorize, audio,
      provider: factory ? { transportFactory: { snapshot(config) { assert.equal(config.model, 'synthetic-asr'); return { networkIdentity: 'synthetic-network', create } } } } : { createTransport: create }, diagnose() {} })
    if (mode === 'cancelled') await assert.rejects(runtime.transcribe(input, controller.signal), error => error instanceof ProviderError && error.code === 'cancelled'
      && !JSON.stringify(error).includes('synthetic-private'))
    else assert.equal(await runtime.transcribe(input, controller.signal), mode === 'success' ? '成功' : '')
    assert.equal(closed, 1)
  }
})

test('native只看主模型实际协议能力与effective开关，独立ASR坏配置不阻断原生，wav/mp3不调用识别HTTP', async () => {
  const f = fixture(); let reads = 0, calls = 0
  const broken = createImVoiceSelection({ pool: emptyPool, environment: {}, authorize: f.authorize, document() { reads++; throw Error('synthetic-broken-config') } })
  for (const protocol of ['openai', 'responses']) {
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: broken, mainConfig: { ...textMain, api_format: protocol, capability_overrides: { audio: true } },
      authorize: f.authorize, audio, provider: { transport: { async request() { calls++; return response({}) } } }, diagnose() {} })
    assert.equal(runtime.nativeAudioSupported, true)
    for (const mime of ['audio/wav', 'audio/mpeg']) {
      const block = await runtime.nativeAudio({ ...input, mime })
      assert.equal(block?.type, 'input_audio'); assert.ok(JSON.stringify(block).includes('base64,'))
      if (protocol === 'responses') {
        const config = { ...textMain, api_format: protocol, capability_overrides: { audio: true } }
        const wire = responsesDriver.project([{ role: 'user', content: [block!] }], config, adapterFor(config))
        assert.ok(!JSON.stringify(wire).includes('data:audio'), '实际Responses投影接受已准入格式并规范化dataURL')
        assert.ok(JSON.stringify(wire).includes('input_audio'))
      }
    }
  }
  assert.equal(reads, 0); assert.equal(calls, 0)
  for (const main of [{ ...textMain, audio: true }, { provider: 'anthropic', model: 'synthetic', api_format: 'anthropic', audio: true, capability_overrides: { audio: true } },
    { ...textMain, audio: true, capability_overrides: { audio: false } }]) {
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: broken, mainConfig: main, authorize: f.authorize, audio, provider: {}, diagnose() {} })
    assert.equal(runtime.nativeAudioSupported, false); assert.equal(await runtime.nativeAudio(input), null)
  }
})

test('原生非wav/mp3只转受控wav，转码后撤权或取消不能返回媒体；字节在异步授权前复制', async () => {
  const f = fixture(), bytes = Buffer.from('original-audio'); let conversions = 0
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: { ...textMain, capability_overrides: { audio: true } },
    async authorize() { bytes.fill(0); return true }, provider: {},
    audio: { ...audio, async toWav(raw) { conversions++; assert.equal(Buffer.from(raw).toString(), 'original-audio'); return Buffer.from('wav-output') } }, diagnose() {} })
  assert.ok(await runtime.nativeAudio({ ...input, bytes, mime: 'audio/ogg', ext: 'ogg' })); assert.equal(conversions, 1)
  const revoked = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: { ...textMain, capability_overrides: { audio: true } }, authorize: f.authorize, provider: {},
    audio: { ...audio, async toWav() { f.deny(); return Buffer.from('wav') } }, diagnose() {} })
  await assert.rejects(revoked.nativeAudio({ ...input, mime: 'audio/ogg' }), /授权/u)
})

test('MiniMax时长必须来自实际probe，伪报duration1但真实501秒/时长未知均固定预检拒绝且零HTTP', async () => {
  for (const duration of [501, null]) {
    const f = fixture('minimax-asr'); let calls = 0, probes = 0
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain, authorize: f.authorize,
      audio: { ...audio, async probeAudioDuration() { probes++; return duration } },
      provider: { transport: { async request() { calls++; return response({ text: '不应送达' }) } } }, diagnose: code => f.diagnostics.push(code) })
    await assert.rejects(runtime.transcribe({ ...input, duration: 1 }), error => error instanceof VendorMediaError
      && error.mediaReason === (duration === null ? 'asr_duration_unknown' : 'asr_duration_limit'))
    assert.equal(probes, 1); assert.equal(calls, 0); assert.ok(f.diagnostics.length > 0)
  }
})

test('转换后的独立ASR输出同样受大小边界约束，超限不能返回空识别或请求Provider', async () => {
  const f = fixture(); let calls = 0
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain, authorize: f.authorize,
    audio: { ...audio, async toWav() { return new Uint8Array(36 * 1024 * 1024 + 1) } },
    provider: { transport: { async request() { calls++; return response({}) } } }, diagnose() {} })
  await assert.rejects(runtime.transcribe({ ...input, mime: 'audio/ogg' }), error => error instanceof ImVoiceRuntimeError && error.code === 'media_limit')
  assert.equal(calls, 0)
  const minimax = fixture('minimax-asr'); let probes = 0
  const limited = createImVoiceRuntime({ ownerId: owner, voice: minimax.voice, mainConfig: textMain, authorize: minimax.authorize,
    audio: { ...audio, async probeAudioDuration() { probes++; return 1 } },
    provider: { transport: { async request() { calls++; return response({}) } } }, diagnose() {} })
  await assert.rejects(limited.transcribe({ ...input, bytes: new Uint8Array(50 * 1024 * 1024 + 1) }),
    error => error instanceof VendorMediaError && error.mediaReason === 'asr_size_limit')
  assert.equal(probes, 0); assert.equal(calls, 0)
})

test('原生转码取消与自建transport清理异常均不被当作空转写继续处理', async () => {
  const f = fixture(), controller = new AbortController()
  const native = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: { ...textMain, capability_overrides: { audio: true } }, authorize: f.authorize,
    audio: { ...audio, async toWav() { controller.abort('synthetic-private'); return Buffer.from('wav') } }, provider: {}, diagnose() {} })
  await assert.rejects(native.nativeAudio({ ...input, mime: 'audio/ogg' }, controller.signal), error => error instanceof ProviderError && error.code === 'cancelled')
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: textMain, authorize: f.authorize, audio,
    provider: { createTransport: () => ({ request: async () => response({ choices: [{ message: { content: '' } }] }), async close() { throw Error('synthetic-private-cleanup') } }) }, diagnose() {} })
  await assert.rejects(runtime.transcribe(input), error => error instanceof ImVoiceRuntimeError && error.code === 'cleanup' && error.cause === undefined)
})

test('音频临时目录清理失败必须传播，兼容ASR驱动分类异常也不能吞掉typed清理错误', async () => {
  for (const native of [false, true]) {
    const f = fixture(); let calls = 0
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice,
      mainConfig: { ...textMain, capability_overrides: { audio: true } }, authorize: f.authorize,
      provider: { transport: { async request() { calls++; return response({}) } } },
      audio: { ...audio, async toWav() { throw new ImAudioCleanupError() } }, diagnose() {} })
    await assert.rejects(native ? runtime.nativeAudio({ ...input, mime: 'audio/ogg' }) : runtime.transcribe({ ...input, mime: 'audio/ogg' }),
      error => error instanceof ImAudioCleanupError && error.cause === undefined)
    assert.equal(calls, 0)
  }
})

test('ASR-only入口复用确切选择，不读取主模型或重新选模；其他owner选择在任何HTTP/缓存读取前拒绝', async () => {
  const f = fixture(), selected = await f.voice.select(owner), other = await f.voice.select('00000000-0000-4000-8000-000000000092')
  let calls = 0, reads = 0
  const transcriber = createImVoiceTranscriber({ ownerId: owner,
    voice: { async select() { throw Error('固定选择不可重新select') } }, authorize: f.authorize, audio,
    async reuse() { reads++; return null }, provider: { transport: { async request() { calls++; return response({ choices: [{ message: { content: '固定选择结果' } }] }) } } }, diagnose() {} })
  await assert.rejects(transcriber.transcribeSelected(input, other), error => error instanceof ImVoiceRuntimeError && error.code === 'unauthorized')
  assert.equal(reads, 0); assert.equal(calls, 0)
  assert.equal(await transcriber.transcribeSelected(input, selected), '固定选择结果')
  assert.equal(calls, 1); assert.equal(reads, 1)
})

test('可信Run缓存正文/空识别均命中且零transport构造；只有null miss才实际ASR，text:null不能伪装成功', async () => {
  for (const cached of ['已识别文本', '']) {
    const f = fixture(); let created = 0
    const transcriber = createImVoiceTranscriber({ ownerId: owner, voice: f.voice, authorize: f.authorize, audio,
      reuse: async () => ({ text: cached }), provider: { createTransport() { created++; throw Error('缓存命中不应构造transport') } }, diagnose() {} })
    assert.equal(await transcriber.transcribe(input), cached); assert.equal(created, 0)
  }
  const f = fixture()
  const malformed = createImVoiceTranscriber({ ownerId: owner, voice: f.voice, authorize: f.authorize, audio,
    reuse: async () => ({ text: null } as unknown as { text: string }), provider: {}, diagnose() {} })
  await assert.rejects(malformed.transcribe(input), error => error instanceof ProviderError && error.code === 'protocol')
})

test('缓存unknown/拒绝原样传播，等待缓存时撤权/更换ASR或取消不允许返回旧文本或重发HTTP', async () => {
  for (const action of ['unknown', 'revoke', 'replace', 'cancel']) {
    const f = fixture(), controller = new AbortController(), blocked = new Error('合成缓存unknown'); let calls = 0
    const transcriber = createImVoiceTranscriber({ ownerId: owner, voice: f.voice, authorize: f.authorize, audio,
      async reuse() {
        if (action === 'unknown') throw blocked
        if (action === 'revoke') f.deny()
        if (action === 'replace') f.change()
        if (action === 'cancel') controller.abort('synthetic-private-cancel')
        return { text: '不能返回的旧缓存' }
      }, provider: { createTransport() { calls++; throw Error('不应构造HTTP') } }, diagnose() {} })
    await assert.rejects(transcriber.transcribe(input, controller.signal), error => action === 'unknown' ? error === blocked
      : action === 'cancel' ? error instanceof ProviderError && error.code === 'cancelled' : error instanceof ImVoiceRuntimeError && error.code === 'unauthorized')
    assert.equal(calls, 0)
  }
})

test('原生字幕独立选ASR，正常/空/普通错误分别completed/empty/failed，未配置不写状态且原生块保留', async () => {
  for (const format of ['openai', 'dashscope', 'minimax-asr']) for (const mode of ['completed', 'empty', 'failed', 'unconfigured'] as const) {
    const f = fixture(format); if (mode === 'unconfigured') f.unconfigure()
    let calls = 0
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice,
      mainConfig: { ...textMain, capability_overrides: { audio: true }, api_key: 'synthetic-main-only' }, authorize: f.authorize, audio,
      provider: { transport: { async request(request) {
        calls++; assert.equal(request.headers.Authorization, 'Bearer synthetic-asr-key')
        const text = mode === 'empty' ? ' \u0085 ' : ' \u001c合成原生字幕\u0085 '
        return mode === 'failed' ? response({ error: 'synthetic-private' }, 401)
          : response(format === 'minimax-asr' ? { text, base_resp: { status_code: 0 } }
            : format === 'dashscope' ? { output: { text } } : { choices: [{ message: { content: text } }] })
      } } }, diagnose: code => f.diagnostics.push(code) })
    const block = await runtime.nativeAudio(input)
    assert.equal(block?.type, 'input_audio')
    assert.deepEqual(await runtime.transcribeNative(input), mode === 'unconfigured' ? null
      : { text: mode === 'completed' ? '合成原生字幕' : mode === 'failed' ? null : '', status: mode })
    assert.equal(calls, mode === 'unconfigured' ? 0 : 1)
    assert.deepEqual(await runtime.nativeAudio(input), block, '字幕错误不能删除或改写原生音频')
    if (mode === 'failed') assert.ok(f.diagnostics.every(code => code === 'im_voice_failed'))
  }
})

test('原生字幕复用可信ASR缓存，unknown只记failed不重发；缓存授权/完整性拒绝不可伪装附加失败', async () => {
  for (const mode of ['hit', 'empty', 'uncertain', 'unauthorized', 'mismatch'] as const) {
    const f = fixture(); let requests = 0, reused = 0
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: { ...textMain, capability_overrides: { audio: true } },
      authorize: f.authorize, audio, async reuse() { reused++
        if (mode === 'uncertain' || mode === 'unauthorized' || mode === 'mismatch') throw new ImVoiceCacheError(mode)
        return { text: mode === 'empty' ? '' : '缓存字幕' }
      }, provider: { createTransport() { requests++; throw Error('缓存分支不得创建HTTP') } }, diagnose() {} })
    if (mode === 'unauthorized' || mode === 'mismatch') await assert.rejects(runtime.transcribeNative(input), ImVoiceCacheError)
    else assert.deepEqual(await runtime.transcribeNative(input), { text: mode === 'uncertain' ? null : mode === 'empty' ? '' : '缓存字幕',
      status: mode === 'uncertain' ? 'failed' : mode === 'empty' ? 'empty' : 'completed' })
    assert.equal(reused, 1); assert.equal(requests, 0)
  }
})

test('原生字幕当前权限/ASR版本变化与取消必须阻断；清理失败继续传播', async () => {
  for (const mode of ['revoke', 'replace', 'cancel', 'cleanup'] as const) {
    const f = fixture(), controller = new AbortController()
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: { ...textMain, capability_overrides: { audio: true } },
      authorize: f.authorize, audio: { ...audio, async toWav() { throw new ImAudioCleanupError() } },
      async reuse() {
        if (mode === 'revoke') f.deny()
        if (mode === 'replace') f.change()
        if (mode === 'cancel') controller.abort('synthetic-private-cancel')
        return mode === 'cleanup' ? null : { text: '不得返回旧字幕' }
      }, provider: {}, diagnose() {} })
    await assert.rejects(runtime.transcribeNative({ ...input, mime: 'audio/ogg', ext: 'ogg' }, controller.signal), error =>
      mode === 'cleanup' ? error instanceof ImAudioCleanupError : mode === 'cancel' ? error instanceof ProviderError && error.code === 'cancelled'
        : error instanceof ImVoiceRuntimeError && error.code === 'unauthorized')
  }
})

test('MiMo Chat五种原生格式经过真实Core投影及HTTP驱动保留数据和格式，扩展格式不转WAV或借ASR凭据', async () => {
  for (const [ext, mime] of [['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['flac', 'audio/flac'], ['m4a', 'audio/mp4'], ['ogg', 'audio/ogg']] as const) {
    const f = fixture(), config: ProviderConfig = { provider: 'mimo', model: 'synthetic-mimo', audio: true, api_format: 'openai',
      base_url: 'https://mimo.example.test/v1', api_key: 'synthetic-main-only' }
    let requests = 0
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: config, authorize: f.authorize,
      audio: { ...audio, async toWav() { assert.fail('已支持的原生格式不得转码') } }, provider: {}, diagnose() {} })
    const block = await runtime.nativeAudio({ ...input, ext, mime }); assert.ok(block)
    const selected = providerSelection(config)
    const result = await selected.driver.complete({ config: selected.config, policy: selected.policy,
      history: selected.driver.project([{ role: 'user', content: [block] }], selected.config, selected.policy),
      system: '', tools: [], signal: new AbortController().signal, purpose: 'standalone',
      scope: { ownerId: owner, sessionId: '1', runId: 'synthetic-native', round: 0, modelIdentity: config.model, accessScopeHash: 'synthetic' } }, {
      digest: () => 'synthetic-hash', transport: { async request(request) {
        requests++; assert.equal(request.headers['api-key'], 'synthetic-main-only')
        const message = (request.body as { messages: Array<{ content: Array<{ input_audio?: { data: string; format: string } }> }> }).messages.at(-1)!
        const media = message.content.find(part => part.input_audio)!.input_audio!
        assert.equal(media.format, ext); assert.equal(media.data, `data:${mime};base64,${Buffer.from(input.bytes).toString('base64')}`)
        assert.ok(!JSON.stringify(request).includes('synthetic-asr-key'))
        return response({ choices: [{ message: { content: '实际驱动收到原生音频' }, finish_reason: 'stop' }] })
      } } })
    assert.equal(result.text, '实际驱动收到原生音频'); assert.equal(requests, 1)
  }
})

test('MiMo Responses扩展原生格式可投影，M3/Anthropic不凭音频产品开关扩大原生协议', async () => {
  const f = fixture()
  for (const config of [{ provider: 'mimo', model: 'synthetic-mimo', api_format: 'anthropic', audio: true },
    { provider: 'minimax', model: 'MiniMax-M3', api_format: 'anthropic', audio: true }]) {
    const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: config, authorize: f.authorize, audio, provider: {}, diagnose() {} })
    assert.equal(runtime.nativeAudioSupported, false); assert.equal(await runtime.nativeAudio(input), null)
  }
  const config: ProviderConfig = { provider: 'mimo', model: 'synthetic-mimo', api_format: 'responses', audio: true }
  const runtime = createImVoiceRuntime({ ownerId: owner, voice: f.voice, mainConfig: config, authorize: f.authorize,
    audio: { ...audio, async toWav() { assert.fail('MiMo Responses支持ogg原生') } }, provider: {}, diagnose() {} })
  const block = await runtime.nativeAudio({ ...input, ext: 'ogg', mime: 'audio/ogg' }); assert.ok(block)
  assert.match(JSON.stringify(responsesDriver.project([{ role: 'user', content: [block] }], config, adapterFor(config))), /"format":"ogg"/)
})
