import type { Json, PortableValue } from '../models.js'
import { portableSnapshot, redactToolRequestHeaders } from '../context/history/canonical-history.js'
import { stripHistoryMedia } from '../context/history/ordering.js'

function redactToolCredentials(text: string): string {
  return text
    .replace(/\b(?:postgres(?:ql)?|redis|rediss|mysql|mongodb):\/\/[^\s'"]+/gi, '‹连接串已隐藏›')
    .replace(/\b(?:sk-[A-Za-z0-9]{16,}|(?:api[_-]?key|token|secret|bearer)["'=:\s]+[A-Za-z0-9._-]{12,})/gi, '‹密钥已隐藏›')
}

/** 对应Python公共错误出口的处理顺序；不用于正常业务正文。 */
export function redactToolError(text: string, keepPaths = false): string {
  const clean = redactToolCredentials(text)
  const message = keepPaths ? clean : clean
    .replace(/(?:\.{0,2}\/)?(?:uploads|\.agent|\.thumbs|\.chat_staging)\/[^\s'"]*|\/(?:home|opt|Users|var|etc|root|tmp|private)\/[^\s'"]*/g, '‹路径已隐藏›')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '‹id已隐藏›')
  return message.replace(/\n?\s*File "[^"]+", line \d+[^\n]*(?:\n\s+[^\n]+)?/g, '')
    .trim()
}

/** 工具参数只投影到 owner 可读的展示时间线，清理凭据和过大的输入。 */
export function projectPersistentToolInput(value: unknown, _toolName?: string): PortableValue {
  function redact(input: Json): Json {
    if (typeof input === 'string') return redactToolCredentials(input)
    if (Array.isArray(input)) return input.map(child => redact(child))
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, child]) => [
      key, /(?:password|passwd|secret|token|credential|api[_-]?key|authorization|cookie|private[_-]?key)/i.test(key)
        ? '[已隐藏]' : redact(child),
    ]))
    return input
  }
  const input = redact(redactToolRequestHeaders(stripHistoryMedia(portableSnapshot(value) as Json)))
  return JSON.stringify(input).length <= 16_000 ? input : '[输入过长，已隐藏]'
}

/**
 * 持久化/展示通用规则：媒体留占位、error递归脱敏；普通文本正文不做秘密字段猜测。
 * 业务凭据必须由可信呈现Adapter与credential交互边界处理，不能把任意正文当错误删改。
 */
export function projectPersistentToolResult(value: unknown, showPaths = false): PortableValue {
  function visit(input: PortableValue): PortableValue {
    const pruned = stripHistoryMedia(input as unknown as Json) as PortableValue
    if (typeof pruned === 'string') {
      const trimmed = pruned.trimStart()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let parsed: unknown
        try {
          parsed = JSON.parse(pruned)
        }
        catch {
          return pruned
        }
        const snapshot = portableSnapshot(parsed)
        const projected = visit(snapshot)
        return JSON.stringify(projected) === JSON.stringify(snapshot) ? pruned : JSON.stringify(projected)
      }
      return pruned
    }
    if (Array.isArray(pruned))
      return pruned.map(visit)
    if (pruned && typeof pruned === 'object') {
      return Object.fromEntries(Object.entries(pruned).map(([name, child]) => [name,
        name === 'error' && typeof child === 'string' ? redactToolError(child, showPaths) : visit(child),
      ]))
    }
    return pruned
  }
  return portableSnapshot(visit(portableSnapshot(value)))
}
