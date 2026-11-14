import { throwIfCancelled } from './errors.js'
import type { MediaLimits, ProviderDriverDependencies } from './contracts.js'
import { ProviderError } from './errors.js'

export const DEFAULT_MEDIA_LIMITS: MediaLimits = Object.freeze({
  audio_max_bytes: 36 * 1024 * 1024, video_source_max_bytes: 500 * 1024 * 1024,
  max_duration_s: 120, duration_limit_inclusive: true, max_size_bytes: 90 * 1024 * 1024,
  image_max_bytes: null, image_mimes: [], image_extensions: [], preserve_image_source: false,
  transcode_video: true, video_mimes: [], compress_max_dim: 1920, compress_bitrate: '5M',
  compress_trigger_bitrate: 16 * 1024 * 1024, transcode_video_mimes: [],
  base64_max: 45 * 1024 * 1024, prefer_file_upload: false, inline_max_bytes: 36 * 1024 * 1024,
})
const mediaMessages = {
  video_duration_unknown: '无法确认视频时长，未发送给 Provider',
  video_duration_limit: '视频时长超过 1800 秒限制，未发送给 Provider',
  video_size_limit: '视频文件超过 MiniMax 的 512 MB 限制，未发送给 Provider',
  image_size_limit: '图片超过当前 Provider 的输入大小限制，未发送给 Provider',
  asr_duration_unknown: '无法确认音频时长，未发送到语音识别服务',
  asr_duration_limit: '音频时长超过语音识别服务的 500 秒上限，未发送到识别服务',
  asr_size_limit: '音频文件超过 MiniMax ASR 的 50 MB 限制，未发送到识别服务',
  asr_pcm: 'MiniMax ASR 不支持无容器的 PCM 音频，未发送到识别服务',
  asr_conversion: '当前语音识别服务不支持该音频格式，且无法转换为受支持格式',
  invalid_encoding: '音频数据编码无效，未发送到识别服务',
} as const
/** 媒体预检只使用固定文案与声明的限制，不回显文件名或媒体正文。 */
export class VendorMediaError extends ProviderError {
  constructor(readonly mediaReason: keyof typeof mediaMessages) {
    super(mediaReason === 'asr_pcm' || mediaReason === 'asr_conversion' ? 'unsupported' : 'input_rejected')
    this.name = 'VendorMediaError'; this.message = mediaMessages[mediaReason]
  }
}

export interface VendorMediaSource {
  readonly name: string
  readonly mime: string
  readonly size: number
  /** 仅可信媒体探测器生成，不得直接使用用户填报的时长。 */
  readonly duration?: number
  /** 二选一。stream由授权媒体层打开并持有；Provider不读取用户FS。 */
  readonly bytes?: Uint8Array
  readonly stream?: () => AsyncIterable<Uint8Array>
}
export interface VendorMediaDependencies extends ProviderDriverDependencies {
  probeVideo?(source: VendorMediaSource, signal: AbortSignal): Promise<{ duration: number | null }>
}

const encoder = new TextEncoder()
function safeFileName(value: string): string { return (value.split(/[\\/]/).at(-1) || 'media').replace(/["\r\n]/g, '_') }

/** 分块multipart不会把大型原视频复制成整份bytes；取消会关闭源迭代器。 */
export function multipartBody(fields: Readonly<Record<string, string>>, file: {
  name: string; mime: string; source: AsyncIterable<Uint8Array>
}, boundary: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{1,70}$/.test(boundary) || /[\r\n]/.test(file.mime)) throw new ProviderError('input_rejected')
  return (async function* () {
    for (const [name, value] of Object.entries(fields)) {
      throwIfCancelled(signal)
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ProviderError('input_rejected')
      yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    }
    yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName(file.name)}"\r\nContent-Type: ${file.mime}\r\n\r\n`)
    for await (const part of file.source) { throwIfCancelled(signal); yield part }
    throwIfCancelled(signal)
    yield encoder.encode(`\r\n--${boundary}--\r\n`)
  })()
}
export function byteSource(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield bytes })()
}
export function validateVendorImage(size: number, mime: string, limits: MediaLimits): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new ProviderError('input_rejected')
  if (typeof limits.image_max_bytes === 'number' && size > limits.image_max_bytes) throw new VendorMediaError('image_size_limit')
  if (Array.isArray(limits.image_mimes) && limits.image_mimes.length && !limits.image_mimes.includes(mime)) throw new ProviderError('unsupported')
}
