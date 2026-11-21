import type { ProviderProtocol } from './contracts.js'
import { isContextOverflowError } from '../context/budget.js'
import { minimaxErrorDetails } from './minimax/errors.js'

export type ProviderErrorCode = 'cancelled' | 'timeout' | 'authentication' | 'rate_limit' | 'busy' | 'network' | 'input_rejected' | 'context_overflow' | 'unsupported' | 'protocol' | 'stream_incomplete' | 'upstream'

export type ProviderProtocolDetail = 'sse_invalid_json' | 'stream_invalid_utf8' | 'stream_line_limit' | 'sse_event_limit' | 'ndjson_invalid_json' | 'ndjson_invalid_record' | 'duplicate_message_start' | 'event_before_message_start' | 'invalid_block_index' | 'unsupported_block_type' | 'event_after_block_stop' | 'unexpected_block_delta' | 'unexpected_stream_event' | 'invalid_tool_identity' | 'invalid_tool_arguments' | 'duplicate_tool_id' | 'invalid_response_shape' | 'missing_content_block' | 'recovery_content_mismatch' | 'unclassified_protocol_error'

export type ProviderFailureStage = 'prepare' | 'transport' | 'http' | 'decode' | 'stream' | 'continuation'

/** 可见消息是固定文案；原始响应、请求和凭据不能成为 Error 字段或 cause。 */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly options: {
    readonly status?: number
    readonly upstreamCode?: string
    readonly upstreamType?: string
    readonly stage?: ProviderFailureStage
    readonly retryAttempt?: number
    readonly retryable?: boolean
    readonly requestStarted?: boolean
    readonly outputStarted?: boolean
    readonly protocolDetail?: ProviderProtocolDetail
    readonly providerProtocol?: ProviderProtocol
    readonly streamEvent?: string
    readonly streamBlockIndex?: number
    readonly streamBlockType?: string
    readonly streamDeltaType?: string
    readonly protocolIncompatible?: boolean
    readonly timeoutPhase?: 'connect' | 'write' | 'read' | 'pool'
    readonly transportCode?: string
    readonly transportHop?: 'dns' | 'proxy' | 'provider'
  } = {}) {
    super(({ cancelled: '模型请求已取消', timeout: '模型请求超时', authentication: '模型认证失败', rate_limit: '模型请求频率受限', busy: '模型服务繁忙', network: '模型网络请求失败', input_rejected: '模型拒绝了当前输入', context_overflow: '模型上下文超出限制', unsupported: '当前模型或协议不支持此能力', protocol: '模型响应协议无效', stream_incomplete: '模型流未完整结束', upstream: '模型服务请求失败' })[code])
    this.name = 'ProviderError'
  }
}

/** 连接测试与本机聊天共用固定错误文案，只附带已校验的 HTTP 状态。 */
export function providerErrorMessage(error: ProviderError): string {
  if (error.code === 'network' && error.options.transportCode
    && certificateErrors.has(error.options.transportCode))
    return '模型连接的 TLS 证书校验失败'
  const status = error.options.status
  return status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599
    ? `${error.message}（HTTP ${status}）` : error.message
}

/** AbortSignal.reason可能包含用户正文，只暴露固定取消错误。 */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError('cancelled')
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

// 自定义上游可以把任意正文放进 error.code。只接受数字码和已知协议枚举。
const upstreamLabels = new Set([
  'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large',
  'rate_limit_error', 'api_error', 'overloaded_error', 'billing_error', 'server_error', 'invalid_api_key',
  'insufficient_quota', 'context_length_exceeded', 'model_not_found', 'content_filter', 'invalid_request',
  'INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED',
])
function safeUpstreamLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const label = String(value)
  return /^\d{1,8}$/u.test(label) || upstreamLabels.has(label) ? label : undefined
}

export function providerFailureFields(error: unknown) {
  const { code, options } = classifyProviderError(error)
  return {
    providerErrorCode: code,
    ...(options.status !== undefined && Number.isInteger(options.status) && options.status >= 100 && options.status <= 599 ? { httpStatus: options.status } : {}),
    ...(safeUpstreamLabel(options.upstreamCode) ? { upstreamCode: options.upstreamCode } : {}),
    ...(safeUpstreamLabel(options.upstreamType) ? { upstreamType: options.upstreamType } : {}),
    providerStage: options.stage ?? 'prepare',
    ...(options.streamBlockType ? { streamBlockType: options.streamBlockType } : {}),
    ...(options.streamDeltaType ? { streamDeltaType: options.streamDeltaType } : {}),
    ...(options.streamEvent ? { streamEvent: options.streamEvent } : {}),
    ...(options.streamBlockIndex !== undefined ? { streamBlockIndex: options.streamBlockIndex } : {}),
    ...(options.providerProtocol ? { providerProtocol: options.providerProtocol } : {}),
    ...(options.protocolDetail ? { protocolDetail: options.protocolDetail } : {}),
    ...(options.retryAttempt === undefined ? {} : { retryAttempt: options.retryAttempt }),
    ...(options.timeoutPhase === undefined ? {} : { timeoutPhase: options.timeoutPhase }),
    ...(options.transportCode && transportCodes.has(options.transportCode) ? { transportCode: options.transportCode } : {}),
    ...(options.transportHop ? { transportHop: options.transportHop } : {}),
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.outputStarted === undefined ? {} : { outputStarted: options.outputStarted }),
    ...(options.requestStarted === undefined ? {} : { requestStarted: options.requestStarted }),
    ...(options.protocolIncompatible === undefined ? {} : { protocolIncompatible: options.protocolIncompatible }),
  }
}

const certificateErrors = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'])
const transportCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'EPROTO', ...certificateErrors])

/** 只提取允许的分类；原错误供诊断端口单独接收，绝不挂在安全错误上。 */
export function classifyProviderError(error: unknown, options: ConstructorParameters<typeof ProviderError>[1] & { providerUrl?: string } = {}): ProviderError {
  if (error instanceof ProviderError) return error
  let current = error
  const seen = new Set<unknown>()
  let status: number | undefined
  let upstreamCode: string | undefined
  let upstreamType: string | undefined
  let transportCode: string | undefined
  const labels: string[] = []
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current)
    const response = own(current, 'response')
    const candidate = own(current, 'status') ?? own(current, 'status_code') ?? own(response, 'status_code') ?? own(response, 'status')
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 400 && candidate <= 599) status = candidate
    for (const key of ['name', 'code', 'type']) {
      const value = own(current, key)
      if (typeof value === 'string') labels.push(value.toLowerCase())
      if (key === 'code' && typeof value === 'string' && transportCodes.has(value)) transportCode ??= value
    }
    const body = own(current, 'body') ?? current
    const detail = own(body, 'error') ?? body
    upstreamCode = safeUpstreamLabel(own(detail, 'code') ?? own(body, 'error_code')) ?? upstreamCode
    upstreamType = safeUpstreamLabel(own(detail, 'type') ?? own(detail, 'status')) ?? upstreamType
    const kind = own(detail, 'type') ?? own(detail, 'code')
    if (typeof kind === 'string') labels.push(kind.toLowerCase())
    current = own(current, 'cause')
  }
  const label = labels.join(' ')
  const { providerUrl, ...safeOptions } = options
  const flags = { ...safeOptions, ...(status === undefined ? {} : { status }), upstreamCode, upstreamType,
    ...(transportCode ? { transportCode } : {}) }
  const vendor = minimaxErrorDetails({ body: own(error, 'body') ?? error, url: providerUrl, status })
  if (vendor && (vendor.context_overflow || /^\d{4,}$/.test(vendor.code))) {
    const code = vendor.context_overflow ? 'context_overflow' : vendor.code === '1001' ? 'timeout' : vendor.code === '1002' ? 'rate_limit'
      : ['1004', '2049'].includes(vendor.code) ? 'authentication' : vendor.retryable ? 'busy' : 'input_rejected'
    return new ProviderError(code, { ...flags, upstreamCode: safeUpstreamLabel(vendor.code) ?? upstreamCode, protocolIncompatible: vendor.context_overflow ? false : flags.protocolIncompatible, retryable: vendor.retryable && !vendor.context_overflow })
  }
  if (isContextOverflowError(error)) return new ProviderError('context_overflow', { ...flags, protocolIncompatible: false, retryable: false })
  if (/abort|cancel/.test(label)) return new ProviderError('cancelled', { ...flags, retryable: false })
  if (/timeout|timedout/.test(label)) return new ProviderError('timeout', { retryable: true, ...flags })
  if (/err_tls|cert_|certificate|self_signed|unable_to_verify_leaf_signature|unable_to_get_issuer_cert/.test(label)) return new ProviderError('network', { ...flags, retryable: false })
  if (status === 401 || status === 403 || /authentication|permission_denied/.test(label)) return new ProviderError('authentication', { ...flags, retryable: false })
  if (status === 429 || /rate_limit/.test(label)) return new ProviderError('rate_limit', { retryable: true, ...flags })
  if (status === 529 || status === 503 || /overload|busy/.test(label)) return new ProviderError('busy', { retryable: true, ...flags })
  if (status === 400 || status === 413 || status === 422 || /invalid_request|invalid_argument/.test(label)) return new ProviderError('input_rejected', { ...flags, retryable: false })
  if (status !== undefined) return new ProviderError('upstream', { retryable: status >= 500, ...flags })
  if (/econnreset|enotfound|econnrefused|eai_again|epipe|ehostunreach|enetunreach|connection|network|fetch|readerror|writeerror|closeerror|remoteprotocolerror|connecterror/.test(label)) return new ProviderError('network', { retryable: true, ...flags })
  return new ProviderError('upstream', { ...flags, retryable: false })
}
