export interface ModelProvider {
  value: string
  labelKey: string
  base_url: string
  model: string
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  { value: 'openai', labelKey: 'adminAgentUi.providerOpenai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { value: 'anthropic', labelKey: 'adminAgentUi.providerAnthropic', base_url: 'https://api.anthropic.com/v1', model: 'claude-opus-4-8' },
  { value: 'qwen', labelKey: 'adminAgentUi.providerQwen', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
  { value: 'glm', labelKey: 'adminAgentUi.providerGlm', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2' },
  { value: 'deepseek', labelKey: 'adminAgentUi.providerDeepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash-vision-exp' },
  { value: 'minimax', labelKey: 'adminAgentUi.providerMinimax', base_url: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3' },
  { value: 'mimo', labelKey: 'adminAgentUi.providerMimo', base_url: 'https://api.xiaomimimo.com/v1', model: 'mimo-mono.5' },
  { value: 'ollama', labelKey: 'adminAgentUi.providerOllama', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
  { value: 'local', labelKey: 'adminAgentUi.providerLocal', base_url: '', model: '' },
]
