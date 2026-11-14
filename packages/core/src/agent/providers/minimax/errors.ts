import { text } from '../values.js'

const messages: Readonly<Record<string, string>> = {
  '1000': '未知或系统默认错误，请稍后再试', '1001': '请求超时，请稍后再试', '1002': '请求频率超限，请稍后再试',
  '1004': '未授权或 API Key 与账户不匹配，请检查 API Key', '1008': '账户余额不足，请检查账户余额',
  '1024': 'MiniMax 内部错误，请稍后再试', '1026': '输入内容触发敏感内容检查，请调整输入内容', '1027': '输出内容触发敏感内容检查，请调整输入内容',
  '1033': '下游服务错误，请稍后再试', '1039': '请求超过 Token 限制，请调整 max_tokens 或缩短上下文', '1041': '连接数达到限制，请稍后再试或联系 MiniMax 支持',
  '1042': '输入包含过多不可见或非法字符，请检查输入内容', '1043': 'ASR 相似度检查失败，请检查音频与校验文本', '1044': '语音克隆提示词与音频相似度检查失败',
  '2013': '请求参数错误，请检查模型、接口格式和请求参数', '20132': '语音克隆样本或 voice_id 参数错误', '2037': '语音克隆样本时长不符合要求',
  '2038': '语音克隆功能未启用，需完成账户认证', '2039': 'voice_id 已存在，请修改后重试', '2042': '当前账户无权访问该 voice_id',
  '2045': '请求频率增长过快，请避免请求量骤增骤减', '2048': '语音克隆提示音频过长', '2049': 'API Key 无效，请检查 API Key', '2056': '已达到 M Plan 资源限制，请等待资源恢复后重试',
}
const httpMessages: Readonly<Record<string, string>> = { '400': '请求参数不合法，例如音频时长超过接口限制', '401': 'API Key 缺失或无效', '402': '账户余额或资源包不足', '413': '请求体超过 50 MB 限制', '422': '音频内容触发敏感内容检查', '429': '请求触发限流，请稍后重试', '500': 'MiniMax 服务端错误，请稍后重试' }
// 与Python预算模块的窄窗口清单保持一致；体量/参数错误不能给用户定性成窗口超限。
const contextPhrases = ['maximum context length', 'context window exceeded', 'context length exceeded', 'context window exceeds limit', 'input token count exceeds']

export interface MiniMaxErrorDetails {
  readonly code: string
  readonly error_type: string
  readonly request_id: string
  readonly summary: string
  readonly description_key: string
  readonly context_overflow: boolean
  readonly retryable: boolean
}
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  if (!value || typeof value !== 'object') return result
  for (const key of keys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor && 'value' in descriptor) result[key] = descriptor.value
    } catch { /* 不执行SDK访问器；未知代理对象不参与错误分类。 */ }
  }
  return result
}
/** 只返回白名单字段和固定文案，原始上游message不逃离诊断边界。 */
export function minimaxErrorDetails(input: { readonly body?: unknown; readonly url?: string; readonly status?: number; readonly headers?: Readonly<Record<string, string>> }): MiniMaxErrorDetails | null {
  const body = data(input.body, ['error', 'base_resp', 'error_code', 'code', 'message', 'request_id', 'trace_id'])
  const error = data(body.error, ['type', 'code', 'error_code', 'message', 'status_msg', 'request_id', 'trace_id'])
  const base = data(body.base_resp, ['status_code', 'status_msg'])
  let host = ''
  try { host = new URL(input.url ?? '').hostname.toLowerCase() } catch { /* body.base_resp可明确标识MiniMax。 */ }
  if (!['minimax.cn', 'minimaxi.com'].some(suffix => host === suffix || host.endsWith('.' + suffix)) && !(body.base_resp !== null && typeof body.base_resp === 'object' && !Array.isArray(body.base_resp))) return null
  const candidates: unknown[] = [error.code, error.error_code, base.status_code, body.error_code, body.code]
  const inputMessages = [error.message, error.status_msg, base.status_msg, body.message].filter((value): value is string => typeof value === 'string')
  for (const value of inputMessages) { const match = /\((\d{3,5})\)\s*$/.exec(value); if (match) candidates.push(match[1]) }
  const code = candidates.map(value => typeof value === 'number' || typeof value === 'string' ? String(value) : '').find(value => /^\d{3,5}$/.test(value)) || (Number.isSafeInteger(input.status) ? String(input.status) : 'unknown')
  const errorType = text(error.type).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || '-'
  const headers = data(input.headers, ['request-id', 'x-request-id', 'trace_id', 'Trace-Id'])
  const requestId = text(body.request_id || body.trace_id || error.request_id || error.trace_id || headers['request-id'] || headers['x-request-id'] || headers.trace_id || headers['Trace-Id']).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128)
  const searchable = inputMessages.join(' ').toLowerCase(), contextOverflow = contextPhrases.some(phrase => searchable.includes(phrase))
  return {
    code, error_type: errorType, request_id: requestId, context_overflow: contextOverflow,
    summary: contextOverflow ? '输入上下文超出模型上下文窗口，请缩短消息、减少附件或工具输出' : messages[code] || httpMessages[code] || 'MiniMax 未返回已收录的错误码，请使用诊断编号排查',
    description_key: contextOverflow ? 'chatUi.minimaxErrorCodes.contextOverflow' : messages[code] ? `chatUi.minimaxErrorCodes.code${code}` : httpMessages[code] ? `chatUi.minimaxErrorCodes.http${code}` : 'chatUi.minimaxErrorCodes.unknown',
    retryable: errorType === 'api_error' && ['1000', '1001', '1002', '1024', '1033'].includes(code),
  }
}
