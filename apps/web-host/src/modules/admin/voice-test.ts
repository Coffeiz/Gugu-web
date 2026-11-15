import { createHash } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { activeVoiceTestSettings, createAdminVoiceConnectionTest, resolveVoicePresetTest, VoicePresetTestError } from '@gugu/core/agent/config/voice-test'
import type { VoiceProbeInput, VoiceProbeResult } from '@gugu/core/agent/config/voice-test'
import { classifyProviderError, minimaxErrorDetails, transcribeCompatibleAsr, transcribeMiniMax, ProviderError } from '@gugu/core/providers'
import type { CompatibleAsrDependencies, ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { redactToolError } from '@gugu/core/agent'
import { readConfigOverride } from '../../adapters/config-override-file.js'

const pythonBoolean = z.preprocess(value => {
  if (value === 0 || value === 1) return Boolean(value)
  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'on', 'y', 't'].includes(value.toLowerCase())) return true
    if (['false', '0', 'no', 'off', 'n', 'f'].includes(value.toLowerCase())) return false
  }
  return value
}, z.boolean())
const request = z.object({
  api_format: z.string().max(32).optional().default('openai'),
  dashscope_service: z.string().max(32).optional().default('qwen3-asr'),
  base_url: z.string().max(500).optional().default(''),
  api_key: z.string().max(4096).optional().default(''),
  model: z.string().max(200).optional().default(''),
  use_config: pythonBoolean.optional().default(true),
})
const presetRequest = request.omit({ use_config: true }).extend({
  name: z.string().min(1).max(80),
  provider: z.enum(['openai', 'qwen', 'minimax', 'local']),
  model: z.string().min(1).max(200),
  preset_id: z.string().max(200).default(''),
})

export interface AdminVoiceTestOptions {
  readonly requireAdmin: preHandlerHookHandler
  readonly test: ReturnType<typeof createAdminVoiceConnectionTest>
}

export interface AdminVoicePresetTestOptions {
  readonly requireAdmin: preHandlerHookHandler
  readonly readDocument: () => unknown | Promise<unknown>
  readonly test: ReturnType<typeof createAdminVoiceConnectionTest>
}

export interface AdminVoiceProbeOptions {
  readonly createTransport?: () => ProviderTransport & { close?(): Promise<void> }
}

function silentWav(): Uint8Array {
  const sampleRate = 16_000, frames = sampleRate
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40)
  return wav
}

function upstreamText(body: string, apiKey: string): string {
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    let message = typeof value.error?.message === 'string' ? value.error.message : typeof value.message === 'string' ? value.message : ''
    if (apiKey) message = message.replaceAll(apiKey, '‹密钥已隐藏›')
    return message ? redactToolError(message).replace(/https?:\/\/[^\s'"<>]+/gi, '‹地址已隐藏›').slice(0, 300) : ''
  } catch { return '' }
}

/** 管理员配置的语音诊断使用共享 ASR 协议和生产安全传输，不读取用户凭据。 */
export function createAdminVoiceProbe(environment: NodeJS.ProcessEnv, options: AdminVoiceProbeOptions = {}) {
  return async (input: VoiceProbeInput): Promise<VoiceProbeResult> => {
    const transport = options.createTransport?.() ?? createNodeProviderTransport({
      allowLocal: true,
      connectTimeoutMs: 10_000,
      environment: () => environment,
    })
    let responseBody = ''
    let responseStatus: number | undefined
    let requestUrl: string | undefined
    const dependencies = {
      transport,
      digest: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      diagnose(code: string, value: unknown) {
        if (code !== 'provider_http' || !value || typeof value !== 'object') return
        const event = value as { body?: unknown; status?: unknown; url?: unknown }
        responseBody = typeof event.body === 'string' ? event.body : event.body === undefined ? '' : JSON.stringify(event.body)
        if (typeof event.status === 'number') responseStatus = event.status
        if (typeof event.url === 'string') requestUrl = event.url
      },
    }
    const config = { ...input, timeout_ms: 15_000 }
    try {
      const media = [{ type: 'audio', mime: 'audio/wav', ext: 'wav', duration: 1, raw: silentWav() }]
      const transcript = input.api_format === 'minimax-asr'
        ? await transcribeMiniMax(media, config, {
          ...dependencies,
          probeAudioDuration: async () => 1,
          toWav: async () => null,
        }, AbortSignal.timeout(15_000), { raiseErrors: true })
        : await transcribeCompatibleAsr(media, config, { ...dependencies, toWav: async () => null } satisfies CompatibleAsrDependencies,
          AbortSignal.timeout(15_000), { raiseErrors: true })
      return { ok: true, transcript }
    } catch (error) {
      const classified = classifyProviderError(error, { providerUrl: requestUrl })
      const status = responseStatus ?? (error instanceof ProviderError ? error.options.status : classified.options.status) ?? 0
      if (input.api_format === 'minimax-asr') {
        const vendor = minimaxErrorDetails({ body: responseBody ? safeJson(responseBody) : undefined, url: requestUrl, status })
        if (vendor) return { ok: false, status, message: vendor.summary, message_key: vendor.description_key,
          message_params: { code: vendor.code, request_id: vendor.request_id } }
      }
      if (status) return { ok: false, status, detail: upstreamText(responseBody, input.api_key) }
      return { ok: false, status: 0, message: classified.code === 'unsupported'
        ? '语音 API 格式暂不支持' : '无法连接语音识别服务，请检查 Base URL、模型和 API Key' }
    } finally {
      await transport.close?.()
    }
  }
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}

export function createAdminVoiceTestOperations(path: string | null, environment: NodeJS.ProcessEnv) {
  return createAdminVoiceConnectionTest({
    readSettings: () => activeVoiceTestSettings(path ? readConfigOverride(path) : {}),
    probe: createAdminVoiceProbe(environment),
  })
}

export function createAdminVoicePresetTestOperations(path: string | null, environment: NodeJS.ProcessEnv) {
  return {
    readDocument: () => path ? readConfigOverride(path) : {},
    test: createAdminVoiceTestOperations(path, environment),
  }
}

export function registerAdminVoiceTestRoute(app: FastifyInstance, options: AdminVoiceTestOptions): void {
  app.post('/api/v1/admin/config/test-voice', { preHandler: options.requireAdmin }, async (request_, reply) => {
    const parsed = request.safeParse(request_.body)
    if (!parsed.success) return reply.code(422).send({ detail: '语音测试参数无效' })
    return options.test(parsed.data)
  })
}

export function registerAdminVoicePresetTestRoute(app: FastifyInstance, options: AdminVoicePresetTestOptions): void {
  app.post('/api/v1/admin/agent/voice-presets/test', { preHandler: options.requireAdmin }, async (request_, reply) => {
    const parsed = presetRequest.safeParse(request_.body)
    if (!parsed.success) return reply.code(422).send({ detail: '语音测试参数无效' })
    try {
      const probe = resolveVoicePresetTest(await options.readDocument(), parsed.data)
      return await options.test({ ...probe, use_config: false })
    } catch (error) {
      if (error instanceof VoicePresetTestError) return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}
