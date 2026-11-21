import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { DesktopAuxiliaryModelDraft } from '@gugu/core/byok/contracts'
import { auxiliaryModelHandlers, createDesktopEmbeddingResolver, createDesktopImVoiceTranscriber } from '../src/main/agent/auxiliary-model.js'
import { desktopAgentAttachmentHandlers } from '../src/main/agent/attachments.js'
import { createDesktopRecordingTranscriber } from '../src/main/agent/voice-recording.js'

it('本机语音和 Embedding 独立启用、加密保存，并用各自的协议测试连接', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-auxiliary-'))
  const plaintext = new Map<string, string>()
  const encryption = {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(value: string) {
      const encrypted = randomBytes(32)
      plaintext.set(encrypted.toString('hex'), value)
      return encrypted
    },
    async decryptStringAsync(value: Buffer) {
      return { result: plaintext.get(value.toString('hex'))!, shouldReEncrypt: false }
    },
  }
  const calls: Array<{ path?: string; key?: string; body: unknown }> = []
  const provider = createServer(async (request, response) => {
    const body = await Array.fromAsync(request)
    calls.push({
      path: request.url, key: request.headers.authorization,
      body: body.length ? JSON.parse(Buffer.concat(body).toString()) : undefined,
    })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.url === '/v1/embeddings' ? { data: [{ embedding: [0, 1, 2] }] }
      : request.url === '/v1/models' ? { data: [{ id: 'engine-a' }] } : { choices: [{ message: { content: '成功' } }] }))
  })

  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const base_url = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`
    const resolvedModels: Array<string | undefined> = []
    const resolveEmbedding = createDesktopEmbeddingResolver(directory, encryption)
    const connect = () => auxiliaryModelHandlers(directory, encryption, undefined, async () => {
      resolvedModels.push((await resolveEmbedding())?.model)
    })[DESKTOP_CHANNELS.auxiliaryModel]!
    const request = connect()
    const speech: DesktopAuxiliaryModelDraft = {
      capability: 'speech_to_text', provider: 'local', base_url, model: 'speech-a', api_format: 'openai', value: 'synthetic-speech-key',
    }
    const embedding: DesktopAuxiliaryModelDraft = { ...speech, capability: 'embedding', model: 'embed-a', dimensions: 3, value: '' }
    await request({ action: 'create', input: speech })
    const diagnose = vi.fn()
    const transcriber = createDesktopImVoiceTranscriber(directory, encryption, {
      async toWav() { return null }, async probeAudioDuration() { return null },
    }, undefined, diagnose)
    const audio = { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/wav', ext: 'wav' }
    await expect(transcriber.transcribe(audio, AbortSignal.timeout(5_000), async () => true)).resolves.toBe('成功')
    expect(calls.at(-1)).toMatchObject({
      path: '/v1/chat/completions', key: 'Bearer synthetic-speech-key',
      body: { model: 'speech-a', messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] },
    })
    const callCount = calls.length
    await expect(transcriber.transcribe(audio, AbortSignal.timeout(5_000), async () => false))
      .rejects.toMatchObject({ name: 'ImVoiceRuntimeError', code: 'unauthorized' })
    expect(calls).toHaveLength(callCount)
    expect(diagnose).not.toHaveBeenCalled()
    expect(resolvedModels).toEqual([])
    await request({ action: 'create', input: embedding })
    await request({ action: 'create', input: { ...embedding, provider: 'ollama', api_format: 'native', model: 'embed-b' } })

    const list = await connect()({ action: 'list' })
    expect(list).toMatchObject({ items: [
      { id: 1, model: 'speech-a', enabled: true, has_value: true },
      { id: 2, model: 'embed-a', enabled: false, dimensions: 3 },
      { id: 3, model: 'embed-b', enabled: true, dimensions: 3 },
    ] })
    expect(JSON.stringify(list)).not.toContain(speech.value)
    expect((await readFile(join(directory, 'auxiliary-models'))).includes(Buffer.from(speech.value))).toBe(false)

    await expect(request({ action: 'test', id: 1 })).resolves.toMatchObject({ ok: true })
    await expect(request({ action: 'test', id: 2 })).resolves.toMatchObject({ ok: true })
    await expect(request({ action: 'test', id: 3 })).resolves.toMatchObject({ ok: true })
    await expect(request({ action: 'models', input: { provider: 'local', base_url, api_format: 'openai', api_key: '', credential_id: 1 } }))
      .resolves.toEqual({ models: ['engine-a'] })
    expect(calls).toMatchObject([
      { path: '/v1/chat/completions', key: 'Bearer synthetic-speech-key', body: { model: 'speech-a' } },
      { path: '/v1/chat/completions', key: 'Bearer synthetic-speech-key' },
      { path: '/v1/embeddings', body: { input: 'ping', model: 'embed-a', dimensions: 3 } },
      { path: '/v1/embeddings', body: { input: 'ping', model: 'embed-b', dimensions: 3 } },
      { path: '/v1/models', key: 'Bearer synthetic-speech-key' },
    ])
    await expect(request({ action: 'update', id: 1, input: { base_url: 'https://example.test/v1' } }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(request({ action: 'preview', input: { ...embedding, capability: 'speech_to_text', credential_id: 2 } }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    expect(calls).toHaveLength(5)
    await request({ action: 'update', id: 2, input: { enabled: true, value: 'synthetic-embedding-key' } })
    await expect(request({ action: 'update', id: 2, input: { value: '' } })).resolves.toMatchObject({ has_value: false })
    expect(await request({ action: 'list' })).toMatchObject({ items: [{ enabled: true }, { enabled: true }, { enabled: false }] })
    await request({ action: 'delete', id: 2 })
    expect(await connect()({ action: 'list' })).toMatchObject({ items: [{ id: 1 }, { id: 3 }] })
    expect(resolvedModels).toEqual(['embed-a', 'embed-b', 'embed-a', 'embed-a', undefined])
    const stage = vi.fn(async <T>(_method: string, params: { attachment: unknown }) => params.attachment as T)
    const upload = desktopAgentAttachmentHandlers({ request: stage }, directory,
      createDesktopRecordingTranscriber(directory, encryption, undefined))[DESKTOP_CHANNELS.agentAttachment]!
    const wav = Buffer.from('524946462800000057415645666d74201000000001000100803e0000007d000002001000646174610400000000000000', 'hex')
    const recording = { action: 'upload', name: '录音.wav', mime: 'audio/wav', voice: true }
    await expect(upload({ ...recording, data: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(calls).toHaveLength(5)
    await expect(upload({ ...recording, data: wav })).resolves.toMatchObject({ transcript: '成功', duration: 2 / 16_000 })
    expect(stage).toHaveBeenCalledWith('agent.attachments.stage', {
      attachment: expect.objectContaining({ transcript: '成功', voice: true }),
    })
    expect(calls.at(-1)).toMatchObject({
      path: '/v1/chat/completions', key: 'Bearer synthetic-speech-key',
      body: { model: 'speech-a', messages: [{ role: 'user', content: [{
        type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` },
      }] }] },
    })

  } finally {
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
