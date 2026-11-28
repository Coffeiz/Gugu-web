import { createHash } from 'node:crypto'
import { ProviderError, VendorMediaError, transcribeCompatibleAsr, transcribeMiniMax,
  type AsrDependencies, type ProviderConfig, type ProviderTransport } from '@gugu/core/providers'
import { createImAudioProcessor, ImAudioCleanupError } from './audio.js'

export interface ImVoiceInput { bytes: Uint8Array; mime: string; ext: string }
export interface ImVoiceSelection {
  readonly ownerId: string
  readonly version: string
  readonly configured: boolean
  readonly config: Readonly<ProviderConfig> | null
  readonly profile: { readonly maxFileBytes: number }
  authorizeCurrent(): Promise<boolean>
}
export interface ImVoiceSelectionPort { select(ownerId: string, signal: AbortSignal): Promise<ImVoiceSelection> }
export interface ImVoiceTranscriberOptions<TInput extends ImVoiceInput = ImVoiceInput> {
  ownerId: string
  voice: ImVoiceSelectionPort
  authorize(): Promise<boolean>
  createTransport(config: ProviderConfig): Promise<{ transport: ProviderTransport; close?(): Promise<void> }> | { transport: ProviderTransport; close?(): Promise<void> }
  diagnose(code: 'im_voice_failed'): void
  audio?: Pick<AsrDependencies, 'toWav' | 'probeAudioDuration'>
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  reuse?(input: TInput, selected: ImVoiceSelection, signal: AbortSignal): Promise<{ text: string } | null>
  raiseErrors?: boolean
}

export interface ImNativeVoiceTranscript { text: string | null; status: 'completed' | 'empty' | 'failed' }

export class ImVoiceRuntimeError extends Error {
  constructor(readonly code: 'unauthorized' | 'cleanup' | 'media_limit') {
    super(code === 'unauthorized' ? 'IM 语音授权或配置已变更' : code === 'cleanup' ? 'IM 语音资源清理未完成' : '音频超过当前模型的输入大小限制，未发送到模型')
    this.name = 'ImVoiceRuntimeError'
  }
}

export const IM_VOICE_MAX_NATIVE_BYTES = 36 * 1024 * 1024
const maximumCapturedVoiceBytes = 64 * 1024 * 1024

export function createImVoiceAccess(options: Pick<ImVoiceTranscriberOptions, 'authorize' | 'diagnose'>) {
  const report = () => { try { options.diagnose('im_voice_failed') } catch { /* 诊断失败不能改变授权或转写结果。 */ } }
  const capture = <T extends ImVoiceInput>(input: T): T => {
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || typeof input.mime !== 'string' || typeof input.ext !== 'string')
      throw new ProviderError('input_rejected')
    if (input.bytes.byteLength > maximumCapturedVoiceBytes) throw new ImVoiceRuntimeError('media_limit')
    return { ...input, bytes: new Uint8Array(input.bytes), mime: input.mime.split(';')[0]!.trim().toLowerCase(), ext: input.ext.toLowerCase().replace(/^\./u, '') }
  }
  async function runAllowed(signal: AbortSignal, authorize = options.authorize) {
    if (signal.aborted) throw new ProviderError('cancelled')
    let allowed = false
    try { allowed = await authorize() === true } catch { /* 授权服务故障按拒绝处理。 */ }
    if (signal.aborted) throw new ProviderError('cancelled')
    if (!allowed) throw new ImVoiceRuntimeError('unauthorized')
  }
  return { capture, runAllowed, report }
}

/** 两个宿主共用授权复核、模型选择固定期、音频限制、ASR 请求及资源关闭策略。 */
export function createImVoiceTranscriber<TInput extends ImVoiceInput = ImVoiceInput>(options: ImVoiceTranscriberOptions<TInput>) {
  const audio = options.audio ?? createImAudioProcessor()
  const { capture, runAllowed, report } = createImVoiceAccess(options)

  async function recognize(input: TInput, selected: ImVoiceSelection, signal: AbortSignal,
    authorizeRequest: () => Promise<boolean> = options.authorize): Promise<string | null> {
    if (selected.ownerId !== options.ownerId) throw new ImVoiceRuntimeError('unauthorized')
    let revoked = false
    async function authorize() {
      try {
        await runAllowed(signal, authorizeRequest)
        if (!await selected.authorizeCurrent()) throw new ImVoiceRuntimeError('unauthorized')
        await runAllowed(signal, authorizeRequest)
      } catch (error) {
        revoked = true
        if (signal.aborted) throw new ProviderError('cancelled')
        throw error instanceof ImVoiceRuntimeError ? error : new ImVoiceRuntimeError('unauthorized')
      }
    }
    await authorize()
    if (options.reuse) {
      const reused = await options.reuse(input, selected, signal)
      await authorize()
      if (reused !== null) {
        if (!selected.configured || !selected.config || !reused || typeof reused.text !== 'string' || reused.text.length > 200_000)
          throw new ProviderError('protocol')
        return reused.text
      }
    }
    if (!selected.configured || !selected.config) return null
    const config = selected.config, minimax = config.api_format === 'minimax-asr'
    let owned: { transport: ProviderTransport; close?(): Promise<void> } | undefined
    let audioCleanupError: ImAudioCleanupError | undefined
    let audioLimitError: ImVoiceRuntimeError | VendorMediaError | undefined
    try {
      if (input.bytes.byteLength > selected.profile.maxFileBytes)
        throw minimax ? new VendorMediaError('asr_size_limit') : new ImVoiceRuntimeError('media_limit')
      await authorize()
      owned = await options.createTransport(config)
      const dependencies: AsrDependencies & { sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void> } = {
        digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
        diagnose: report,
        sleep: options.sleep,
        transport: { async request(request, requestSignal) {
          await authorize()
          if (requestSignal.aborted) throw new ProviderError('cancelled')
          const result = await owned!.transport.request(request, requestSignal)
          try { await authorize(); return result } catch (error) { await result.cancel(); throw error }
        } },
        async toWav(raw, conversionSignal) {
          await authorize()
          try {
            const result = await audio.toWav(raw, conversionSignal)
            await authorize()
            if (result && result.byteLength > selected.profile.maxFileBytes)
              throw minimax ? new VendorMediaError('asr_size_limit') : new ImVoiceRuntimeError('media_limit')
            return result
          } catch (error) {
            if (error instanceof ImAudioCleanupError) audioCleanupError = error
            if (error instanceof VendorMediaError || error instanceof ImVoiceRuntimeError && error.code === 'media_limit') audioLimitError = error
            throw error
          }
        },
        async probeAudioDuration(raw, extension, probeSignal) {
          await authorize()
          try {
            const result = await audio.probeAudioDuration(raw, extension, probeSignal)
            await authorize()
            return result
          } catch (error) {
            if (error instanceof ImAudioCleanupError) audioCleanupError = error
            throw error
          }
        },
      }
      const media = [{ type: 'audio' as const, raw: input.bytes, mime: input.mime, ext: input.ext }]
      const text = minimax ? await transcribeMiniMax(media, config, dependencies, signal, { raiseErrors: true })
        : await transcribeCompatibleAsr(media, config, dependencies, signal, { raiseErrors: true })
      await authorize()
      return text
    } catch (error) {
      await authorize()
      if (revoked) throw new ImVoiceRuntimeError('unauthorized')
      if (audioCleanupError) { report(); throw audioCleanupError }
      if (audioLimitError) { report(); throw audioLimitError }
      if (error instanceof ImAudioCleanupError || error instanceof VendorMediaError) { report(); throw error }
      if (error instanceof ImVoiceRuntimeError || error instanceof ProviderError && error.code === 'cancelled') throw error
      report()
      if (options.raiseErrors) throw error
      if (minimax && error instanceof ProviderError && (error.options.status !== undefined
        || error.code === 'upstream' && error.options.requestStarted === undefined)) throw error
      return ''
    } finally {
      if (owned?.close) try { await owned.close() } catch { report(); throw new ImVoiceRuntimeError('cleanup') }
    }
  }

  return {
    async transcribe(input: TInput, signal = new AbortController().signal,
      authorizeRequest: () => Promise<boolean> = options.authorize): Promise<string | null> {
      const captured = capture(input)
      await runAllowed(signal, authorizeRequest)
      const selected = await options.voice.select(options.ownerId, signal)
      return recognize(captured, selected, signal, authorizeRequest)
    },
    transcribeSelected(input: TInput, selected: ImVoiceSelection, signal = new AbortController().signal,
      authorizeRequest: () => Promise<boolean> = options.authorize): Promise<string | null> {
      return recognize(capture(input), selected, signal, authorizeRequest)
    },
  }
}

