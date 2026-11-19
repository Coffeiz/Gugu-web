const enums = new Map(Object.entries({
  errorCode: ['upstream_failed', 'tool_failed', 'invalid_arguments', 'result_unknown', 'provider_error', 'rate_limited', 'timeout', 'transport', 'upstream_busy', 'unknown', 'cancelled'],
  finishReason: ['stop', 'end_turn', 'tool_calls', 'tool_use', 'length', 'max_tokens', 'incomplete', 'failed', 'content_filter', 'unknown'],
  incompleteReason: ['max_output_tokens', 'content_filter', 'unknown', 'other'],
  reason: ['same_round_batch', 'provider_threshold', 'below_threshold', 'retry_deferred', 'failed', 'no_change', 'applied', 'summary_failed', 'not_applied'],
  choice: ['disabled', 'pending', 'reply', 'silent'],
  mode: ['parallel'],
}).map(([key, values]) => [key, new Set(values)]))

const counters = new Set([
  'attempt', 'maxRetries', 'nextRetryMs', 'elapsedMs', 'isolatedInvalid',
  'calls', 'succeeded', 'failed', 'cancelled', 'deferred', 'waiting', 'unknown',
  'used', 'limit', 'toolCallCount', 'toolCallsUsed', 'outputTokens', 'count', 'revision', 'contextInput',
])
const flags = new Set(['executed', 'mutated', 'contextOverflow', 'hasText', 'requiresTools', 'goalMode', 'applied'])
const phases = new Set(['prepare', 'idle', 'provider', 'tools', 'decision'])
const runErrors = new Set(['not_found', 'conflict', 'lease_lost', 'invalid_state', 'cancelled', 'persistence_unknown'])

export function runFields(attributes) {
  return Object.fromEntries(Object.entries(attributes ?? {}).filter(([key, value]) =>
    typeof value === 'number' && Number.isFinite(value) && counters.has(key)
    || typeof value === 'boolean' && flags.has(key)
    || typeof value === 'string' && enums.get(key)?.has(value)))
}

export function runPhase(phase) {
  return phases.has(phase) ? phase : 'unknown'
}

export function failureCode(error) {
  const code = error instanceof Error ? error.code : null
  return typeof code === 'string' && (runErrors.has(code) || /^(?:\d{2}|P0|XX)[0-9A-Z]{3}$/.test(code))
    ? code : 'internal_error'
}

/** 私有诊断保留堆栈位置，过滤消息、完整路径、连接串和远端返回体。 */
export function errorFrames(error) {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return []
  return error.stack.split('\n').slice(1, 21).flatMap(line => {
    const location = /^\s+at\s.+(?:[\\/]|\()([\w.-]{1,80}\.(?:[cm]?js|ts)):(\d+):(\d+)\)?$/.exec(line)
    return location ? [`${location[1]}:${location[2]}:${location[3]}`] : []
  })
}
