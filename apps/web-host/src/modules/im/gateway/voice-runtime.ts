import { createHash } from 'node:crypto'
import type { Block } from '@gugu/core/agent'
import { adapterFor, capabilitySnapshot, MIMO_AUDIO_NATIVE_EXTS, ProviderError, VendorMediaError, transcribeCompatibleAsr, transcribeMiniMax,
  type AsrDependencies, type ProviderConfig, type ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransportFactory } from '@gugu/core/providers/node'
import type { ImAgentReconstructionResources } from './agent-reconstructor.js'
import type { ImAudioInput } from './message-materializer.js'
import type { createImVoiceSelection, ImVoiceSelection } from './voice-config.js'
import { createImAudioProcessor, ImAudioCleanupError } from './audio.js'
import { strip } from '@gugu/core/shared/values'
import { ImVoiceCacheError } from './voice-cache.js'

export interface ImNativeVoiceTranscript { text: string | null; status: 'completed' | 'empty' | 'failed' }

export class ImVoiceRuntimeError extends Error {
  constructor(readonly code: 'unauthorized' | 'cleanup' | 'media_limit') {
    super(code === 'unauthorized' ? 'IM 语音授权或配置已变更' : code === 'cleanup' ? 'IM 语音资源清理未完成' : '音频超过当前模型的输入大小限制，未发送到模型'); this.name = 'ImVoiceRuntimeError'
  }
}
const maximumNativeBytes = 36 * 1024 * 1024

/** 普通Run与注意力预转写共用独立ASR；不需要主模型配置。 */
export interface ImVoiceTranscriberOptions {
  ownerId: string; voice: ReturnType<typeof createImVoiceSelection>
  authorize(): Promise<boolean>; provider: ImAgentReconstructionResources['provider']
  diagnose(code: 'im_voice_failed'): void
  audio?: Pick<AsrDependencies, 'toWav' | 'probeAudioDuration'>
  reuse?(input: ImAudioInput, selected: ImVoiceSelection, signal: AbortSignal): Promise<{ text: string } | null>
}
function createVoiceAccess(options: Pick<ImVoiceTranscriberOptions, 'authorize' | 'diagnose'>) {
  const report = () => { try { options.diagnose('im_voice_failed') } catch { /* 诊断失败不改变授权及转写结果。 */ } }
  const capture = (input: ImAudioInput) => {
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || typeof input.mime !== 'string' || typeof input.ext !== 'string')
      throw new ProviderError('input_rejected')
    if (input.bytes.byteLength > 64 * 1024 * 1024) throw new ImVoiceRuntimeError('media_limit')
    return { ...input, bytes: new Uint8Array(input.bytes), mime: input.mime.split(';')[0]!.trim().toLowerCase(), ext: input.ext.toLowerCase().replace(/^\./u, '') }
  }
  async function runAllowed(signal: AbortSignal) {
    if (signal.aborted) throw new ProviderError('cancelled')
    let allowed = false
    try { allowed = await options.authorize() === true } catch { /* 访问服务故障按拒绝处理，不放行媒体或正文。 */ }
    if (signal.aborted) throw new ProviderError('cancelled')
    if (!allowed) throw new ImVoiceRuntimeError('unauthorized')
  }
  return { capture, runAllowed, report }
}

export function createImVoiceTranscriber(options: ImVoiceTranscriberOptions) {
  return createVoiceTranscriber(options, false)
}
function createVoiceTranscriber(options: ImVoiceTranscriberOptions, raiseCaptionErrors: boolean) {
  const audio = options.audio ?? createImAudioProcessor(), { capture, runAllowed, report } = createVoiceAccess(options)
  async function recognize(item: ImAudioInput, selected: ImVoiceSelection, signal: AbortSignal): Promise<string | null> {
      if (selected.ownerId !== options.ownerId) throw new ImVoiceRuntimeError('unauthorized')
      let revoked = false
      async function authorize() {
        try {
          await runAllowed(signal)
          if (!await selected.authorizeCurrent()) throw new ImVoiceRuntimeError('unauthorized')
          await runAllowed(signal)
        } catch (error) { revoked = true; if (signal.aborted) throw new ProviderError('cancelled'); throw error instanceof ImVoiceRuntimeError ? error : new ImVoiceRuntimeError('unauthorized') }
      }
      await authorize()
      // 缓存拒绝/unknown越过普通ASR失败边界，不能降为空串后再发送HTTP。
      if (options.reuse) {
        const reused = await options.reuse(item, selected, signal)
        await authorize()
        if (reused !== null) {
          if (!selected.configured || !selected.config || !reused || typeof reused.text !== 'string' || reused.text.length > 200_000) throw new ProviderError('protocol')
          return reused.text
        }
      }
      if (!selected.configured || !selected.config) return null
      const config = selected.config, minimax = config.api_format === 'minimax-asr'
      let owned: (ProviderTransport & { close(): Promise<void> }) | undefined
      let audioCleanupError: ImAudioCleanupError | undefined
      let audioLimitError: ImVoiceRuntimeError | VendorMediaError | undefined
      try {
        if (item.bytes.byteLength > selected.profile.maxFileBytes) throw minimax ? new VendorMediaError('asr_size_limit') : new ImVoiceRuntimeError('media_limit')
        const supplied = options.provider
        let transport: ProviderTransport
        if (supplied.transport) transport = supplied.transport
        else {
          await authorize()
          owned = supplied.transportFactory ? supplied.transportFactory.snapshot(config).create()
            : supplied.createTransport ? supplied.createTransport(config) : createNodeProviderTransportFactory().snapshot(config).create()
          transport = owned
        }
        const dependencies: AsrDependencies & { sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void> } = {
          digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'), diagnose: report,
          sleep: supplied.clock?.sleep,
          transport: { async request(request, requestSignal) {
            await authorize(); if (requestSignal.aborted) throw new ProviderError('cancelled')
            const result = await transport.request(request, requestSignal)
            try { await authorize(); return result } catch (error) { await result.cancel(); throw error }
          } },
          async toWav(raw, conversionSignal) {
            await authorize()
            try {
              const result = await audio.toWav(raw, conversionSignal); await authorize()
              if (result && result.byteLength > selected.profile.maxFileBytes) throw minimax ? new VendorMediaError('asr_size_limit') : new ImVoiceRuntimeError('media_limit')
              return result
            }
            catch (error) {
              if (error instanceof ImAudioCleanupError) audioCleanupError = error
              if (error instanceof VendorMediaError || error instanceof ImVoiceRuntimeError && error.code === 'media_limit') audioLimitError = error
              throw error
            }
          },
          async probeAudioDuration(raw, extension, probeSignal) {
            await authorize()
            try { const result = await audio.probeAudioDuration(raw, extension, probeSignal); await authorize(); return result }
            catch (error) { if (error instanceof ImAudioCleanupError) audioCleanupError = error; throw error }
          },
        }
        // 平台/附件duration不是已证明的探测结果；MiniMax必须由受控probe读取实际音频。
        const media = [{ type: 'audio', raw: item.bytes, mime: item.mime, ext: item.ext }]
        const text = minimax ? await transcribeMiniMax(media, config, dependencies, signal, { raiseErrors: true })
          : await transcribeCompatibleAsr(media, config, dependencies, signal, { raiseErrors: true })
        await authorize()
        return text
      } catch (error) {
        await authorize()
        if (revoked) throw new ImVoiceRuntimeError('unauthorized')
        if (audioCleanupError) { report(); throw audioCleanupError }
        if (audioLimitError) { report(); throw audioLimitError }
        if (error instanceof ImAudioCleanupError) { report(); throw error }
        if (error instanceof VendorMediaError) { report(); throw error }
        if (error instanceof ImVoiceRuntimeError || error instanceof ProviderError && error.code === 'cancelled') throw error
        report()
        if (raiseCaptionErrors) throw error
        // Python preparation的raise_minimax_errors仅传播已识别的上游错误；普通解码/探测失败仍为没听清。
        if (minimax && error instanceof ProviderError && (error.options.status !== undefined
          || error.code === 'upstream' && error.options.requestStarted === undefined)) throw error
        return ''
      } finally {
        if (owned) try { await owned.close() } catch { report(); throw new ImVoiceRuntimeError('cleanup') }
      }
  }
  return {
    async transcribe(input: ImAudioInput, signal = new AbortController().signal): Promise<string | null> {
      const item = capture(input)
      await runAllowed(signal)
      const selected = await options.voice.select(options.ownerId, signal)
      return recognize(item, selected, signal)
    },
    transcribeSelected(input: ImAudioInput, selected: ImVoiceSelection, signal = new AbortController().signal): Promise<string | null> {
      return recognize(capture(input), selected, signal)
    },
  }
}

/** 原生音频只依赖实际冻结主模型；独立ASR损坏/未配置不阻断主模型原生听音频。 */
export function createImVoiceRuntime(options: ImVoiceTranscriberOptions & { mainConfig: ProviderConfig }) {
  const main = structuredClone(options.mainConfig), audio = options.audio ?? createImAudioProcessor()
  const { capture, runAllowed, report } = createVoiceAccess(options)
  const policy = adapterFor(main), protocol = policy.protocol(main)
  const formats = protocol === 'responses' ? policy.responsesInputCapabilities(main).audio_formats
    : policy.name === 'mimo' ? MIMO_AUDIO_NATIVE_EXTS : ['mp3', 'wav']
  const nativeAudioSupported = (main.capability_overrides?.audio ?? main.audio) === true && capabilitySnapshot(main).audio === true
    && ['openai', 'responses'].includes(protocol) && formats.length > 0
  const transcriber = createImVoiceTranscriber({ ...options, audio })
  const captionTranscriber = createVoiceTranscriber({ ...options, audio }, true)
  return { nativeAudioSupported, ...transcriber,
    /** 原生音频的可选字幕；独立ASR不可用不切断主模型，但授权/取消/资源清理失败不能降级掩盖。 */
    async transcribeNative(input: ImAudioInput, signal = new AbortController().signal): Promise<ImNativeVoiceTranscript | null> {
      if (!nativeAudioSupported) return null
      try {
        const transcript = await captionTranscriber.transcribe(input, signal)
        if (transcript === null) return null
        const text = strip(transcript)
        return { text, status: text ? 'completed' : 'empty' }
      } catch (error) {
        await runAllowed(signal)
        if (error instanceof ImAudioCleanupError || error instanceof ImVoiceRuntimeError && ['unauthorized', 'cleanup'].includes(error.code)
          || error instanceof ImVoiceCacheError && error.code !== 'uncertain'
          || error instanceof ProviderError && error.code === 'cancelled') throw error
        report()
        return { text: null, status: 'failed' }
      }
    },
    async nativeAudio(input: ImAudioInput, signal = new AbortController().signal): Promise<Block | null> {
      if (!nativeAudioSupported) return null
      const item = capture(input)
      await runAllowed(signal)
      try {
        if (item.bytes.byteLength > maximumNativeBytes) throw new ImVoiceRuntimeError('media_limit')
        let bytes = item.bytes
        let format = ['audio/wav', 'audio/x-wav'].includes(item.mime) ? 'wav' : ['audio/mpeg', 'audio/mp3'].includes(item.mime) ? 'mp3' : ''
        if (policy.name === 'mimo' && formats.includes(item.ext) && ({ flac: ['audio/flac', 'audio/x-flac'],
          m4a: ['audio/mp4', 'audio/m4a', 'audio/x-m4a'], ogg: ['audio/ogg', 'application/ogg'] } as Record<string, string[]>)[item.ext]?.includes(item.mime)) format = item.ext
        if (!formats.includes(format)) {
          if (!formats.includes('wav')) return null
          await runAllowed(signal)
          const converted = await audio.toWav(bytes, signal)
          await runAllowed(signal)
          if (!converted || !converted.byteLength) { report(); return null }
          if (converted.byteLength > maximumNativeBytes) throw new ImVoiceRuntimeError('media_limit')
          bytes = new Uint8Array(converted); format = 'wav'
        }
        await runAllowed(signal)
        const mime = format === 'mp3' ? 'audio/mpeg' : format === 'm4a' ? 'audio/mp4' : `audio/${format}`
        return { type: 'input_audio', input_audio: { format, data: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` } }
      } catch (error) {
        await runAllowed(signal)
        if (error instanceof ImAudioCleanupError) { report(); throw error }
        if (error instanceof ImVoiceRuntimeError || error instanceof ProviderError && error.code === 'cancelled') throw error
        report(); return null
      }
    },
  }
}
