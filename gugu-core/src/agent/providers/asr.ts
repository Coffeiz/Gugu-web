import type { ProviderConfig } from './contracts.js'
import { ProviderError } from './errors.js'
import { transcribeDashscopeAsr } from './qwen/asr.js'
import { transcribeOpenAiAsr } from './openai/asr.js'
import type { AsrMedia, CompatibleAsrDependencies } from './asr/shared.js'

export type { AsrMedia, AsrDependencies, CompatibleAsrDependencies } from './asr/shared.js'
export {
  dashscopeAsrEndpoint, dashscopeAsrTranscript, transcribeDashscopeAsr,
} from './qwen/asr.js'
export {
  MINIMAX_ASR_MAX_FILE_BYTES, MINIMAX_ASR_MAX_DURATION_SECONDS,
  minimaxAsrEndpoint, minimaxAudioFormat, transcribeMiniMax,
} from './minimax/asr.js'

/** 兼容旧调用点；按原生 API 格式分派到 Provider 适配器。 */
export function transcribeCompatibleAsr(
  media: readonly AsrMedia[], config: ProviderConfig, dependencies: CompatibleAsrDependencies,
  signal: AbortSignal, options: { readonly raiseErrors?: boolean } = {},
): Promise<string> {
  const format = config.api_format?.trim().toLowerCase() || 'openai'
  if (format === 'dashscope') return transcribeDashscopeAsr(media, config, dependencies, signal, options)
  if (format === 'openai') return transcribeOpenAiAsr(media, config, dependencies, signal, options)
  throw new ProviderError('unsupported')
}
