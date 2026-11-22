import { redactToolError } from '../core.js'
import { vendorMediaCapabilities } from './media/capabilities.js'
import { providerSelection } from './registry.js'
import type { JsonObject, ProviderConfig, ProviderHttpResponse } from './contracts.js'
import { createNodeProviderTransport, type NodeProviderTransportOptions } from './transport/node.js'

// 预生成的 64 × 64 纯蓝 RGB PNG。
const imagePng = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ2oPcf88OIhvJ6vAAAAAElFTkSuQmCC'

// 预生成的 3 秒纯蓝 H.264 MP4。探测时只发送合成样本。
const videoSample =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAQTbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAC7gAAQAAAQAAAAAAAAAAAAAAAAEAAAAA' +
  'AAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAz10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAAB' +
  'AAAAAAAAC7gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAUAAAADwAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAA' +
  'AAEAAAu4AAAQAAABAAAAAAK1bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAAkABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRl' +
  'b0hhbmRsZXIAAAACYG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAiBzdGJsAAAAwHN0c2QA' +
  'AAAAAAAAAQAAALBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAA8ABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDAgbGlieDI2NAAAAAAAAAAAAAAA' +
  'GP//AAAANmF2Y0MBZAAM/+EAGWdkAAys2UFB+wEQAAADABAAAAMAwPFCmWABAAZo6+PLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAACt0A' +
  'AAAAAAAAGHN0dHMAAAAAAAAAAQAAABIAAAgAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAACgY3R0cwAAAAAAAAASAAAAAQAAEAAAAAABAAAoAAAAAAEAABAAAAAA' +
  'AQAAAAAAAAABAAAIAAAAAAEAACgAAAAAAQAAEAAAAAABAAAAAAAAAAEAAAgAAAAAAQAAKAAAAAABAAAQAAAAAAEAAAAAAAAAAQAACAAAAAABAAAoAAAAAAEA' +
  'ABAAAAAAAQAAAAAAAAABAAAIAAAAAAEAABAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAASAAAAAQAAAFxzdHN6AAAAAAAAAAAAAAASAAAC+AAAABEAAAAOAAAA' +
  'DgAAAA4AAAAXAAAAEAAAAA4AAAAOAAAAFwAAABAAAAAOAAAADgAAABcAAAAQAAAADgAAAA4AAAAXAAAAFHN0Y28AAAAAAAAAAQAABEMAAABidWR0YQAAAFpt' +
  'ZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMAAAAAhm' +
  'cmVlAAAEG21kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVj' +
  'IC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2Nr' +
  'PTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hy' +
  'b21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9' +
  'MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3Ry' +
  'YWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdo' +
  'dHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49NiBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBj' +
  'cmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAENliIQAE//+6uP8yy2wFzYK' +
  'paojjX1uV1NPSExEvcZban24Vx67PWABH/B7369AkyZZ7UCPgAAFOCbWWAhMprxYSTmdAAAADUGaJGxBP/61KoAADlgAAAAKQZ5CeIIfAAAR8QAAAAoBnmF0' +
  'Q/8AACggAAAACgGeY2pD/wAAKCEAAAATQZpoSahBaJlMCCX//rUqgAAOWQAAAAxBnoZFESwQ/wAAEfEAAAAKAZ6ldEP/AAAoIQAAAAoBnqdqQ/8AACggAAAA' +
  'E0GarEmoQWyZTAgl//61KoAADlgAAAAMQZ7KRRUsEP8AABHxAAAACgGe6XRD/wAAKCAAAAAKAZ7rakP/AAAoIAAAABNBmvBJqEFsmUwIIf/+qlUAAByxAAAA' +
  'DEGfDkUVLBD/AAAR8QAAAAoBny10Q/8AACghAAAACgGfL2pD/wAAKCAAAAATQZsxSahBbJlMCH///qmWAABvwA=='

function silentWavBase64(): string {
  const sampleRate = 8_000, frames = 800
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40)
  return wav.toString('base64')
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
export function createByokMediaCapabilityProbeRunner(environment: NodeJS.ProcessEnv, transportOptions?: (config: ProviderConfig) => NodeProviderTransportOptions) {
  return async (target: ByokMediaProbeTarget, dim: ByokMediaDimension) => {
    let selection: ReturnType<typeof providerSelection>
    try {
      selection = providerSelection({
        provider: target.provider, api_format: target.apiFormat === 'native' ? undefined : target.apiFormat || undefined,
        ...(target.provider === 'ollama' && target.apiFormat && { ollama_api_mode: target.apiFormat === 'native' ? 'native' : 'openai' }), base_url: target.baseUrl || undefined,
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
    if (protocol === 'ollama' && dim !== 'image')
      return { supported: null, status: 0, detail: 'Ollama 原生协议暂不支持检测此媒体类型' }
    if (protocol === 'responses' && dim !== 'image')
      return { supported: null, status: 0, detail: `尚无已验证的 Responses ${label(dim)}探测格式，不能据此判断模型能力` }

    const body: JsonObject | null = protocol === 'ollama'
      ? { model: config.model, stream: false, options: { num_predict: 16 },
        messages: [{ role: 'user', content: '这张图是什么颜色？用一个词回答。', images: [imagePng] }] }
      : dim === 'video' && protocol === 'openai'
        ? { model: config.model, max_tokens: 16, messages: [{ role: 'user', content: [
          { type: 'text', text: '这段视频是什么颜色？用一个词回答。' },
          { type: 'video_url', video_url: { url: `data:video/mp4;base64,${videoSample}` }, fps: 2 },
        ] }] }
        : requestBody(dim, protocol, config.model)
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
      : protocol === 'responses' ? 'responses' : protocol === 'ollama' ? 'chat' : 'chat/completions'
    const connectionOptions = transportOptions?.({ ...config, base_url: baseUrl }) ?? {
      allowLocal: ['local', 'ollama'].includes(policy.name.toLowerCase()),
    }
    const transport = createNodeProviderTransport({
      connectTimeoutMs: 10_000, environment: () => environment, ...connectionOptions,
    })
    const timeoutMs = dim === 'video' ? 90_000 : 25_000
    try {
      const response = await transport.request({
        url: `${baseUrl}/${path}`, method: 'POST', headers, body, timeoutMs, allowLocal: connectionOptions.allowLocal,
      }, AbortSignal.timeout(timeoutMs))
      const raw = await consumeResponse(response)
      if (response.status >= 200 && response.status < 300)
        return { supported: true, status: 200, detail: `模型接受了${label(dim)}输入` }
      const message = errorMessage(raw, key)
      if (response.status === 400 || response.status === 422) {
        const media = dim === 'image' ? 'image|vision|image_url' : dim === 'video' ? 'video|video_url' : 'audio|input_audio'
        const unsupported = new RegExp(`(?:does not support|do not support|doesn't support|don't support|unsupported)\\s+(?:any\\s+)?(?:${media})\\b|\\b(?:${media})(?:\\s+inputs?)? (?:is |are )?not supported|(?:only supports|supports only) text`, 'i')
        if (unsupported.test(message))
          return { supported: false, status: response.status, detail: `模型拒绝了${label(dim)}输入：${message}` }
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

export interface ByokMediaProbeTarget { provider: string; apiFormat: string; baseUrl: string; model: string; apiKey: string }

export interface ByokMediaProbeResult { dim: ByokMediaDimension; supported: boolean | null; status: number; detail: string }
