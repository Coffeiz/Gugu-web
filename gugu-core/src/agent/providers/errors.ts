import { isContextOverflowError } from '../harness/context/budget.js'
import { minimaxErrorDetails } from './vendors/minimax-errors.js'

export type ProviderErrorCode = 'cancelled' | 'timeout' | 'authentication' | 'rate_limit' | 'busy' | 'network' | 'input_rejected' | 'context_overflow' | 'unsupported' | 'protocol' | 'stream_incomplete' | 'upstream'

/** 可见消息是固定文案；原始响应、请求和凭据不能成为 Error 字段或 cause。 */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly options: {
    readonly status?: number
    readonly retryable?: boolean
    readonly requestStarted?: boolean
    readonly outputStarted?: boolean
    readonly protocolIncompatible?: boolean
    readonly timeoutPhase?: 'connect' | 'write' | 'read' | 'pool'
  } = {}) {
    super(({ cancelled: '模型请求已取消', timeout: '模型请求超时', authentication: '模型认证失败', rate_limit: '模型请求频率受限', busy: '模型服务繁忙', network: '模型网络请求失败', input_rejected: '模型拒绝了当前输入', context_overflow: '模型上下文超出限制', unsupported: '当前模型或协议不支持此能力', protocol: '模型响应协议无效', stream_incomplete: '模型流未完整结束', upstream: '模型服务请求失败' })[code])
    this.name = 'ProviderError'
  }
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

/** 只提取允许的分类；原错误供诊断端口单独接收，绝不挂在安全错误上。 */
export function classifyProviderError(error: unknown, options: ConstructorParameters<typeof ProviderError>[1] & { providerUrl?: string } = {}): ProviderError {
  if (error instanceof ProviderError) return error
  let current = error
  const seen = new Set<unknown>()
  let status: number | undefined
  const labels: string[] = []
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current)
    const response = own(current, 'response')
    const candidate = own(current, 'status') ?? own(current, 'status_code') ?? own(response, 'status_code') ?? own(response, 'status')
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 400 && candidate <= 599) status = candidate
    for (const key of ['name', 'code', 'type']) {
      const value = own(current, key)
      if (typeof value === 'string') labels.push(value.toLowerCase())
    }
    const body = own(current, 'body') ?? current
    const detail = own(body, 'error') ?? body
    const kind = own(detail, 'type') ?? own(detail, 'code')
    if (typeof kind === 'string') labels.push(kind.toLowerCase())
    current = own(current, 'cause')
  }
  const label = labels.join(' ')
  const { providerUrl, ...safeOptions } = options
  const flags = { ...safeOptions, ...(status === undefined ? {} : { status }) }
  const vendor = minimaxErrorDetails({ body: own(error, 'body') ?? error, url: providerUrl, status })
  if (vendor && (vendor.context_overflow || /^\d{4,}$/.test(vendor.code))) {
    const code = vendor.context_overflow ? 'context_overflow' : vendor.code === '1001' ? 'timeout' : vendor.code === '1002' ? 'rate_limit'
      : ['1004', '2049'].includes(vendor.code) ? 'authentication' : vendor.retryable ? 'busy' : 'input_rejected'
    return new ProviderError(code, { ...flags, protocolIncompatible: vendor.context_overflow ? false : flags.protocolIncompatible, retryable: vendor.retryable && !vendor.context_overflow })
  }
  if (isContextOverflowError(error)) return new ProviderError('context_overflow', { ...flags, protocolIncompatible: false, retryable: false })
  if (/abort|cancel/.test(label)) return new ProviderError('cancelled', { ...flags, retryable: false })
  if (/timeout|timedout/.test(label)) return new ProviderError('timeout', { retryable: true, ...flags })
  if (/err_tls|cert_|certificate|self_signed/.test(label)) return new ProviderError('network', { ...flags, retryable: false })
  if (status === 401 || status === 403 || /authentication|permission_denied/.test(label)) return new ProviderError('authentication', { ...flags, retryable: false })
  if (status === 429 || /rate_limit/.test(label)) return new ProviderError('rate_limit', { retryable: true, ...flags })
  if (status === 529 || status === 503 || /overload|busy/.test(label)) return new ProviderError('busy', { retryable: true, ...flags })
  if (status === 400 || status === 413 || status === 422 || /invalid_request|invalid_argument/.test(label)) return new ProviderError('input_rejected', { ...flags, retryable: false })
  if (status !== undefined) return new ProviderError('upstream', { retryable: status >= 500, ...flags })
  if (/econnreset|enotfound|econnrefused|eai_again|connection|network|fetch|readerror|writeerror|closeerror|remoteprotocolerror|connecterror/.test(label)) return new ProviderError('network', { retryable: true, ...flags })
  return new ProviderError('upstream', { ...flags, retryable: false })
}
