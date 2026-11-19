import { readOwnedCredential, type OwnedCredential } from '../store.js'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { redactToolError } from '@gugu/core/agent'
import { vendorMediaCapabilities, providerSelection, type JsonObject, type ProviderHttpResponse } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import type { Kysely } from 'kysely'
import { dataContext } from '@gugu/core/contracts'
import { canReuseByokKeyForDestination, BYOK_DESTINATION_MISMATCH_MESSAGE } from '@gugu/core/byok/policy'

const runFile = promisify(execFile)

const imagePng = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAlklEQVR4nO3QMQ0AMAzAsPLHWC4rDB/L4T/K7O772egArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0A6OSM1jeqEVYAAAAAElFTkSuQmCC'

let videoSample: Promise<string> | undefined

function silentWavBase64(): string {
  const sampleRate = 8_000, frames = 800
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40)
  return wav.toString('base64')
}

async function videoSampleBase64(): Promise<string> {
  videoSample ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-byok-media-probe-'))
    const file = join(directory, 'sample.mp4')
    try {
      await runFile('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error', '-threads', '1',
        '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file,
      ], { timeout: 30_000, maxBuffer: 1024 * 1024 })
      const data = await readFile(file)
      if (!data.length) throw new Error('empty video sample')
      return data.toString('base64')
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  })()
  try { return await videoSample }
  catch (error) { videoSample = undefined; throw error }
}

function label(dim: ByokMediaDimension): string { return dim === 'image' ? '图片' : dim === 'audio' ? '音频' : '视频' }

function knownCapability(config: ReturnType<typeof providerSelection>['config'], protocol: string, dim: ByokMediaDimension) {
  const capabilities = vendorMediaCapabilities(config)
  if (config.provider === 'minimax' && protocol === 'anthropic' && dim === 'video') {
    return capabilities.supports_video === true
      ? { supported: true, status: 200, detail: 'MiniMax M3 原生支持视频块' }
      : { supported: false, status: 200, detail: 'Anthropic 路当前仅 MiniMax M3 支持视频块' }
  }
  if (config.provider === 'mimo' && (dim === 'audio' || dim === 'video')) {
    const supported = capabilities[dim === 'audio' ? 'supports_audio' : 'supports_video'] === true
    if (supported) return { supported: true, status: 200, detail: `MiMo 原生支持${label(dim)}输入` }
  }
  return null
}

function requestBody(dim: ByokMediaDimension, protocol: string, model: string): JsonObject | null {
  const text = dim === 'image' ? '这张图是什么颜色？用一个词回答。'
    : dim === 'audio' ? '这段音频说了什么？用一个词回答。' : '这段视频里发生了什么？用一个词回答。'
  if (protocol === 'anthropic') {
    if (dim === 'video') return null
    const media = dim === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imagePng } }
      : { type: 'input_audio', source: { type: 'base64', media_type: 'audio/wav', data: silentWavBase64() } }
    return { model, max_tokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text }, media] }] }
  }
  if (protocol === 'responses') {
    if (dim !== 'image') return null
    return { model, max_output_tokens: 16, input: [{ role: 'user', content: [
      { type: 'input_text', text }, { type: 'input_image', image_url: `data:image/png;base64,${imagePng}`, detail: 'auto' },
    ] }] }
  }
  if (dim === 'video') return null
  const content: JsonObject[] = [{ type: 'text', text }]
  if (dim === 'image') content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${imagePng}`, detail: 'auto' } })
  else content.push({ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${silentWavBase64()}` } })
  return { model, max_tokens: 16, messages: [{ role: 'user', content }] }
}

function errorMessage(body: string, apiKey: string): string {
  let message = ''
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    message = typeof value.error?.message === 'string' ? value.error.message
      : typeof value.message === 'string' ? value.message : ''
  } catch { /* 上游可能返回非 JSON；正文只用于分类，不原样回显。 */ }
  if (!message) return 'Provider 未提供可用的错误说明'
  if (apiKey) message = message.replaceAll(apiKey, '‹密钥已隐藏›')
  return redactToolError(message).replace(/https?:\/\/[^\s'"<>]+/gi, '‹地址已隐藏›').slice(0, 200)
}

async function consumeResponse(response: ProviderHttpResponse, limit = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > limit) return ''
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await response.cancel() }
}

/** 经 Provider Host 固定 DNS、地址校验、限时和禁止重定向的真实媒体探测。 */
export function createByokMediaCapabilityProbeRunner(environment: NodeJS.ProcessEnv) {
  return async (target: ByokMediaProbeTarget, dim: ByokMediaDimension) => {
    let selection: ReturnType<typeof providerSelection>
    try {
      selection = providerSelection({
        provider: target.provider, api_format: target.apiFormat || undefined, base_url: target.baseUrl || undefined,
        model: target.model, api_key: target.apiKey,
      })
    } catch (error) {
      const type = error instanceof Error ? error.name : 'Error'
      return { supported: null, status: 0, detail: `检测初始化失败（${type}），请检查 Provider、协议和 Base URL` }
    }
    const { policy, driver, config } = selection
    const protocol = driver.protocol
    const known = knownCapability(config, protocol, dim)
    if (known) return known
    if (protocol === 'responses' && dim !== 'image')
      return { supported: null, status: 0, detail: `尚无已验证的 Responses ${label(dim)}探测格式，不能据此判断模型能力` }

    let body: JsonObject | null
    try {
      if (dim === 'video' && protocol !== 'anthropic' && protocol !== 'responses') {
        const sample = await videoSampleBase64()
        body = { model: config.model, max_tokens: 16, messages: [{ role: 'user', content: [
          { type: 'text', text: '这段视频里发生了什么？用一个词回答。' },
          { type: 'video_url', video_url: { url: `data:video/mp4;base64,${sample}` }, fps: 2 },
        ] }] }
      } else body = requestBody(dim, protocol, config.model)
    } catch {
      return { supported: null, status: 200, detail: '无法生成视频探测样本：ffmpeg 不可用或生成失败' }
    }
    if (!body) {
      return protocol === 'anthropic'
        ? { supported: false, status: 200, detail: 'Anthropic 路不支持该媒体探测类型' }
        : { supported: null, status: 0, detail: '不支持的探测类型' }
    }

    const anthropic = protocol === 'anthropic'
    const key = typeof config.api_key === 'string' ? config.api_key.trim() : ''
    const headers = {
      Accept: 'application/json',
      ...(anthropic ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
        : key ? { Authorization: `Bearer ${key}` } : {}),
      ...policy.headers(config),
    }
    const baseUrl = policy.baseUrl(config).replace(/\/+$/, '')
    const path = anthropic ? (baseUrl.endsWith('/v1') ? 'messages' : 'v1/messages')
      : protocol === 'responses' ? 'responses' : 'chat/completions'
    const allowLocal = ['local', 'ollama'].includes(policy.name.toLowerCase())
    const transport = createNodeProviderTransport({ allowLocal, connectTimeoutMs: 10_000, environment: () => environment })
    const timeoutMs = dim === 'video' ? 90_000 : 25_000
    try {
      const response = await transport.request({
        url: `${baseUrl}/${path}`, method: 'POST', headers, body, timeoutMs, allowLocal,
      }, AbortSignal.timeout(timeoutMs))
      const raw = await consumeResponse(response)
      if (response.status >= 200 && response.status < 300)
        return { supported: true, status: 200, detail: `模型接受了${label(dim)}输入` }
      const message = errorMessage(raw, key)
      const lower = raw.toLowerCase()
      if (response.status === 400 || response.status === 422) {
        const hints = ['not support', 'unsupported', 'does not support', "don't support", 'invalid image', 'invalid video', 'invalid audio',
          'image not', 'video not', 'audio not', 'media type', 'content type', 'unrecognized', 'unknown field', 'image_url', 'video_url', 'input_audio', 'image_urls']
        if (hints.some(hint => lower.includes(hint)))
          return { supported: false, status: response.status, detail: `模型拒绝了${label(dim)}输入，应为纯文本模型：${message}` }
        return { supported: null, status: response.status, detail: `未能判定（${response.status}）：${message}` }
      }
      if (response.status === 401 || response.status === 403)
        return { supported: null, status: response.status, detail: `鉴权失败（${response.status}），先确认 Key/连通性再测` }
      if (response.status === 404)
        return { supported: null, status: 404, detail: `模型名或地址不对（404）：${message}` }
      return { supported: null, status: response.status, detail: `未能判定：${message}` }
    } catch {
      return { supported: null, status: 0, detail: '未能判定：Provider 网络请求失败或超时' }
    } finally { await transport.close() }
  }
}

export type ByokMediaDimension = 'image' | 'audio' | 'video'

export interface ByokMediaProbeInput {
  provider: string; api_format: string; base_url: string; model: string; api_key: string
  credential_id?: number | null; dim: ByokMediaDimension
}

export interface ByokMediaProbeTarget { provider: string; apiFormat: string; baseUrl: string; model: string; apiKey: string }

export interface ByokMediaProbeResult { dim: ByokMediaDimension; supported: boolean | null; status: number; detail: string }

/** 复用旧凭据前验证 owner 与有效 origin；草稿探测不产生持久化副作用。 */
export function createByokMediaCapabilityProbe<DB>(db: Kysely<DB>, options: {
  enabled(): boolean
  decrypt(row: Pick<OwnedCredential, 'encrypted_value' | 'nonce' | 'encrypted_data_key' | 'key_version'>): Promise<string>
  probe(target: ByokMediaProbeTarget, dim: ByokMediaDimension): Promise<Omit<ByokMediaProbeResult, 'dim'>>
}) {
  return async (rawOwner: string, input: ByokMediaProbeInput): Promise<ByokMediaProbeResult> => {
    if (!options.enabled()) throw Object.assign(new Error('用户 BYOK 未开放'), { statusCode: 403 })
    const owner = dataContext(rawOwner).ownerId
    let row: OwnedCredential | undefined
    if (input.credential_id != null) {
      row = await readOwnedCredential(db, owner, input.credential_id)
    }
    let apiKey = input.api_key
    if (!apiKey) {
      if (!row) throw Object.assign(new Error('请填写 API Key 后再检测'), { statusCode: 422 })
      const target = { provider: input.provider, api_format: input.api_format, base_url: input.base_url, model: input.model, capability: row.capability }
      if (!canReuseByokKeyForDestination(row, target))
        throw Object.assign(new Error(BYOK_DESTINATION_MISMATCH_MESSAGE), { statusCode: 422 })
      try { apiKey = await options.decrypt(row) }
      catch { throw Object.assign(new Error('凭据无法解密，请重新保存'), { statusCode: 422 }) }
    }
    if (!apiKey) throw Object.assign(new Error('请先填写 API Key 或保存后再检测'), { statusCode: 422 })
    const result = await options.probe({ provider: input.provider, apiFormat: input.api_format, baseUrl: input.base_url, model: input.model, apiKey }, input.dim)
    return { dim: input.dim, ...result }
  }
}
