import type { Block } from '@gugu/core/agent'
import { adapterFor, capabilitySnapshot, MIMO_AUDIO_NATIVE_EXTS, ProviderError,
  type AsrDependencies, type ProviderConfig, type ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransportFactory } from '@gugu/core/providers/node'
import type { ImAgentReconstructionResources } from '../agent/reconstruct.js'
import type { ImAudioInput } from '../inbound/message.js'
import type { createImVoiceSelection, ImVoiceSelection } from './config.js'
import { createImAudioProcessor, createImVoiceAccess, createImVoiceTranscriber as createSharedImVoiceTranscriber,
  IM_VOICE_MAX_NATIVE_BYTES, ImAudioCleanupError, ImVoiceRuntimeError } from '@gugu/gateway/media'
import { strip } from '@gugu/core/shared/values'
import { ImVoiceCacheError } from './cache.js'

export interface ImNativeVoiceTranscript { text: string | null; status: 'completed' | 'empty' | 'failed' }
export { ImVoiceRuntimeError }

/** Web Host 注入账号选择、授权、传输和可选复用；转写执行策略由 Gateway 共用。 */
export interface ImVoiceTranscriberOptions {
  ownerId: string; voice: ReturnType<typeof createImVoiceSelection>
  authorize(): Promise<boolean>; provider: ImAgentReconstructionResources['provider']
  diagnose(code: 'im_voice_failed'): void
  audio?: Pick<AsrDependencies, 'toWav' | 'probeAudioDuration'>
  reuse?(input: ImAudioInput, selected: ImVoiceSelection, signal: AbortSignal): Promise<{ text: string } | null>
}

function createVoiceTransport(options: ImVoiceTranscriberOptions, config: ProviderConfig) {
  const supplied = options.provider
  if (supplied.transport) return { transport: supplied.transport }
  const owned = supplied.transportFactory ? supplied.transportFactory.snapshot(config).create()
    : supplied.createTransport ? supplied.createTransport(config) : createNodeProviderTransportFactory().snapshot(config).create()
  return { transport: owned, close: () => owned.close() }
}

function sharedTranscriberOptions(options: ImVoiceTranscriberOptions, audio: ImVoiceTranscriberOptions['audio'], raiseErrors = false) {
  return {
    ownerId: options.ownerId, voice: options.voice, authorize: options.authorize, diagnose: options.diagnose,
    audio, reuse: options.reuse, sleep: options.provider.clock?.sleep,
    ...(raiseErrors ? { raiseErrors: true } : {}),
    createTransport: (config: ProviderConfig) => createVoiceTransport(options, config),
  }
}

export function createImVoiceTranscriber(options: ImVoiceTranscriberOptions) {
  return createSharedImVoiceTranscriber<ImAudioInput>(sharedTranscriberOptions(options, options.audio))
}

/** 原生音频只依赖实际冻结主模型；独立ASR损坏/未配置不阻断主模型原生听音频。 */
export function createImVoiceRuntime(options: ImVoiceTranscriberOptions & { mainConfig: ProviderConfig }) {
  const main = structuredClone(options.mainConfig), audio = options.audio ?? createImAudioProcessor()
  const { capture, runAllowed, report } = createImVoiceAccess(options)
  const policy = adapterFor(main), protocol = policy.protocol(main)
  const formats = protocol === 'responses' ? policy.responsesInputCapabilities(main).audio_formats
    : policy.name === 'mimo' ? MIMO_AUDIO_NATIVE_EXTS : ['mp3', 'wav']
  const nativeAudioSupported = (main.capability_overrides?.audio ?? main.audio) === true && capabilitySnapshot(main).audio === true
    && ['openai', 'responses'].includes(protocol) && formats.length > 0
  const transcriber = createImVoiceTranscriber({ ...options, audio })
  const captionTranscriber = createSharedImVoiceTranscriber<ImAudioInput>(sharedTranscriberOptions(options, audio, true))
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
        if (item.bytes.byteLength > IM_VOICE_MAX_NATIVE_BYTES) throw new ImVoiceRuntimeError('media_limit')
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
          if (converted.byteLength > IM_VOICE_MAX_NATIVE_BYTES) throw new ImVoiceRuntimeError('media_limit')
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
