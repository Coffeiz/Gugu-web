import type { CanonicalMessage, RunIdentity } from '../models.js'
import type { JsonObject, ProviderConfig, ProviderDriverDependencies, ProviderPolicy } from './contracts.js'
import { ProviderStreamSanitizer, sanitizeProviderText, stripThinking } from './sanitize.js'
import { providerSelection } from './registry.js'
import { ProviderError } from './errors.js'
import type { ProviderInvocation } from './contracts.js'

/** 明确null保留Provider默认上限，不把推理预算强加给无限设置。 */
export function outputBudget(config: ProviderConfig, policy: ProviderPolicy, requested: number | null): number | null {
  if (requested === null) return null
  const reasoning = policy.reasoningCapabilities(config, policy.protocol(config))
  return reasoning.modes.length || reasoning.efforts.length ? Math.max(requested, 4096) : requested
}

/** 与旧非聊天入口一致：先去精确思考标签，再容忍代码围栏，仅接受JSON对象。 */
export function parseStructuredJson(text: string): JsonObject {
  let value = stripThinking(text).trim()
  if (value.includes('```')) { value = value.split('```', 3)[1] ?? ''; if (value.startsWith('json')) value = value.slice(4) }
  const first = value.indexOf('{'), last = value.lastIndexOf('}')
  if (first < 0 || last < first) return {}
  try { const parsed: unknown = JSON.parse(value.slice(first, last + 1)); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {} }
  catch { return {} }
}

/** 通过共享协议驱动执行不依赖聊天 Run 的短文本请求；Host 必须注入受控 transport。 */
export async function completeStandaloneText(input: {
  config: ProviderConfig
  system?: string
  prompt: string
  history?: readonly CanonicalMessage[]
  maxTokens: number | null
  outputMode?: 'text' | 'json'
  thinking?: string | null
  exactMaxTokens?: boolean
  signal: AbortSignal
  identity: RunIdentity
  onText?: (delta: string) => void
}, dependencies: ProviderDriverDependencies): Promise<string> {
  const { config, policy, driver } = providerSelection({ ...input.config, ...(input.thinking === undefined ? {} : { thinking: input.thinking }) })
  const history = driver.project([...(input.history ?? []), { role: 'user', content: input.prompt }], config, policy)
  const invocation: ProviderInvocation = {
    config, policy, history, system: input.system ?? '', tools: [], signal: input.signal,
    scope: { ...input.identity, round: 0, modelIdentity: config.model, accessScopeHash: '' },
    purpose: 'standalone', maxOutputTokens: input.exactMaxTokens ? input.maxTokens : outputBudget(config, policy, input.maxTokens),
    ...(input.outputMode === undefined ? {} : { outputMode: input.outputMode }),
  }
  if (!input.onText) return stripThinking((await driver.complete(invocation, dependencies)).text).trim()

  const markers = policy.sanitizerMarkers(config)
  const filter = new ProviderStreamSanitizer(markers)
  for await (const event of driver.stream(invocation, dependencies)) {
    if (event.type === 'error') throw event.error
    if (event.type === 'token') {
      const delta = filter.feed(event.text)
      if (delta) input.onText(delta)
    }
    if (event.type === 'complete') {
      const tail = filter.flush()
      if (tail) input.onText(tail)
      return sanitizeProviderText(event.text, markers).trim()
    }
  }
  throw new ProviderError('stream_incomplete')
}
