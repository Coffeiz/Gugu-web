export interface ReasoningCapabilities {
  reasoning_modes?: readonly string[]
  reasoning_efforts?: readonly string[]
}

export interface ThinkingOption {
  value: string
  label: string
}

const effortLabelKeys: Record<string, string> = {
  minimal: 'profileByokUi.minimal',
  low: 'profileByokUi.low',
  medium: 'profileByokUi.medium',
  high: 'profileByokUi.high',
  xhigh: 'profileByokUi.xhigh',
  max: 'profileByokUi.maximum',
}

/** 根据 Provider 能力快照生成 Admin 和 BYOK 共用的思考选项。 */
export function buildThinkingOptions(
  capabilities: ReasoningCapabilities | null | undefined,
  translate: (key: string) => string,
): ThinkingOption[] {
  const modes = capabilities?.reasoning_modes || []
  const options: ThinkingOption[] = [{ value: 'default', label: translate('profileByokUi.inheritDefault') }]
  if (modes.includes('disabled')) options.push({ value: 'disabled', label: translate('profileByokUi.disableThinking') })
  if (modes.includes('adaptive')) options.push({ value: 'adaptive', label: translate('profileByokUi.adaptiveThinking') })

  for (const effort of capabilities?.reasoning_efforts || []) {
    if (effort === 'none' || !(effort in effortLabelKeys)) continue
    if (modes.length > 0 && !modes.includes('adaptive')) continue
    options.push({ value: effort, label: translate(effortLabelKeys[effort]) })
  }
  return options
}
