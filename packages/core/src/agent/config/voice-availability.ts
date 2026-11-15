export interface VoiceAvailabilitySettings {
  readonly model?: string
  readonly api_format?: string
  readonly dashscope_service?: string
}

/** 与 Python agent.voice.supports_configured_voice_model 相同的配置可用性规则。 */
export function supportsConfiguredVoiceModel(settings: VoiceAvailabilitySettings | null | undefined): boolean {
  const model = typeof settings?.model === 'string' ? settings.model.trim() : ''
  if (!model) return false
  const format = typeof settings?.api_format === 'string' && settings.api_format.trim()
    ? settings.api_format.trim().toLowerCase() : 'openai'
  if (format === 'dashscope') {
    const service = typeof settings?.dashscope_service === 'string' && settings.dashscope_service.trim()
      ? settings.dashscope_service.trim().toLowerCase() : 'qwen3-asr'
    return ['qwen3-asr', 'qwen-audio', 'fun-asr'].includes(service)
  }
  if (format === 'minimax-asr') return model === 'asr-1.0'
  return format === 'openai'
}

export function createVoiceAvailabilityReader(readSettings: (ownerId: string) => Promise<VoiceAvailabilitySettings>) {
  return async (ownerId: string): Promise<boolean> => supportsConfiguredVoiceModel(await readSettings(ownerId))
}
