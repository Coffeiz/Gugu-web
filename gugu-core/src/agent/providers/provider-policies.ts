import type { ProviderPolicy } from './contracts.js'
import { deepseekPolicy } from './deepseek/policy.js'
import { glmCodingPolicy, glmPolicy } from './glm/policy.js'
import { localPolicy } from './local/policy.js'
import { minimaxPolicy } from './minimax/policy.js'
import { mimoPolicy } from './mimo/policy.js'
import { ollamaPolicy } from './ollama/policy.js'
import { qwenPolicy } from './qwen/policy.js'

/** 各 Provider 策略的唯一注册表；策略实现按厂商目录维护。 */
export const providerPolicies: Readonly<Record<string, ProviderPolicy>> = Object.freeze({
  deepseek: deepseekPolicy, glm: glmPolicy, 'glm-coding': glmCodingPolicy, qwen: qwenPolicy,
  minimax: minimaxPolicy, mimo: mimoPolicy, local: localPolicy, ollama: ollamaPolicy,
})

/** 兼容旧公共导出名称。 */
export const vendorPolicies = providerPolicies
