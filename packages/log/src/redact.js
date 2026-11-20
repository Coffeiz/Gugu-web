const enums = new Map(Object.entries({
  errorCode: ['upstream_failed', 'tool_failed', 'invalid_arguments', 'result_unknown', 'provider_error', 'rate_limited', 'timeout', 'transport', 'upstream_busy', 'unknown', 'cancelled'],
  providerErrorCode: ['cancelled', 'timeout', 'authentication', 'rate_limit', 'busy', 'network', 'input_rejected', 'context_overflow', 'unsupported', 'protocol', 'stream_incomplete', 'upstream'],
  streamBlockType: ['text', 'tool_use', 'thinking', 'redacted_thinking', 'unknown'],
  streamDeltaType: ['text_delta', 'input_json_delta', 'thinking_delta', 'signature_delta', 'citations_delta', 'unknown'],
  streamEvent: ['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop'],
  providerProtocol: ['openai', 'responses', 'anthropic', 'ollama'],
  protocolDetail: ['sse_invalid_json', 'stream_invalid_utf8', 'stream_line_limit', 'sse_event_limit', 'ndjson_invalid_json', 'ndjson_invalid_record', 'duplicate_message_start', 'event_before_message_start', 'invalid_block_index', 'unsupported_block_type', 'event_after_block_stop', 'unexpected_block_delta', 'unexpected_stream_event', 'invalid_tool_identity', 'invalid_tool_arguments', 'duplicate_tool_id', 'invalid_response_shape', 'missing_content_block', 'recovery_content_mismatch', 'unclassified_protocol_error'],
  providerStage: ['prepare', 'transport', 'http', 'decode', 'stream', 'continuation'],
  timeoutPhase: ['connect', 'write', 'read', 'pool'],
  finishReason: ['stop', 'end_turn', 'tool_calls', 'tool_use', 'length', 'max_tokens', 'incomplete', 'failed', 'content_filter', 'unknown'],
  incompleteReason: ['max_output_tokens', 'content_filter', 'unknown', 'other'],
  reason: ['same_round_batch', 'provider_threshold', 'below_threshold', 'retry_deferred', 'failed', 'no_change', 'applied', 'summary_failed', 'not_applied', 'mixed_batch', 'parallel_disabled'],
  shellAvailabilityReason: ['invalid_session', 'shell_disabled', 'sandbox_unavailable', 'workspace_unavailable', 'account_unavailable', 'lease_inactive', 'im_unauthorized', 'user_disabled', 'confirmation_unavailable'],
  choice: ['disabled', 'pending', 'reply', 'silent'],
  mode: ['parallel', 'serial'],
  status: ['completed', 'failed', 'cancelled', 'unknown'],
  outcome: ['success', 'error', 'waiting', 'unknown', 'cancelled', 'deferred', 'invalid'],
}).map(([key, values]) => [key, new Set(values)]))

const counters = new Set([
  'retryAttempt', 'attempt', 'maxRetries', 'nextRetryMs', 'elapsedMs', 'durationMs', 'isolatedInvalid',
  'calls', 'succeeded', 'failed', 'cancelled', 'deferred', 'waiting', 'unknown',
  'used', 'limit', 'toolCallCount', 'toolCallsUsed', 'outputTokens', 'count', 'revision', 'contextInput',
])
const flags = new Set(['retryable', 'outputStarted', 'requestStarted', 'protocolIncompatible', 'executed', 'mutated', 'contextOverflow', 'hasText', 'requiresTools', 'goalMode', 'applied'])
const phases = new Set(['prepare', 'idle', 'provider', 'tools', 'decision'])
const runErrors = new Set(['not_found', 'conflict', 'lease_lost', 'invalid_state', 'cancelled', 'persistence_unknown'])

export function runFields(attributes) {
  return Object.fromEntries(Object.entries(attributes ?? {}).filter(([key, value]) =>
    typeof value === 'number' && Number.isFinite(value) && counters.has(key)
    || typeof value === 'boolean' && flags.has(key)
    || key === 'streamBlockIndex' && Number.isSafeInteger(value) && value >= 0
    || key === 'httpStatus' && Number.isInteger(value) && value >= 100 && value <= 599
    || (key === 'upstreamCode' || key === 'upstreamType') && typeof value === 'string'
      && /^(?:[0-9]{1,8}|[a-z][a-z_]{1,31}|[A-Z][A-Z_]{1,31})$/u.test(value)
    || key === 'tool' && typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value)
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
