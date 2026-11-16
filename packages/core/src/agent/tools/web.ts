import { z } from 'zod'
import type { ToolDefinition } from './contracts.js'

const schema = z.object({
  url: z.string().optional(),
  urls: z.array(z.string().min(1)).min(1).max(5).optional(),
  max_chars: z.number().int().optional(),
}).passthrough().superRefine((value, context) => {
  if (Boolean(value.url) === Boolean(value.urls)) context.addIssue({ code: 'custom', message: '需提供 url 或 urls 其中之一' })
  if (value.url !== undefined && !value.url.trim()) context.addIssue({ code: 'custom', message: '缺少 url 或 urls' })
  if (value.urls && value.urls.some(url => !url.trim())) context.addIssue({ code: 'custom', message: 'urls 中每个元素都必须是非空字符串' })
  if (value.urls && new Set(value.urls).size !== value.urls.length) context.addIssue({ code: 'custom', message: 'urls 不能包含重复 URL' })
})

export interface HttpGetPort {
  /** Host 必须固定并校验公网 DNS 目标、拒绝重定向，并负责正文类型解析。 */
  get(input: { ownerId: string; url: string; maxChars: number }, signal: AbortSignal): Promise<Record<string, unknown>>
}

const maxBody = 4000
const maxBodyHard = 40000

function normalizeUrl(raw: string): { url: string } | { error: string } {
  const value = raw.trim()
  if (!value) return { error: '缺少 url' }
  const candidate = value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`
  try {
    const parsed = new URL(candidate)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password)
      return { error: '非法 url' }
    return { url: candidate }
  } catch { return { error: '非法 url' } }
}

async function fetchOne(port: HttpGetPort, ownerId: string, url: string, maxChars: number, signal: AbortSignal) {
  try {
    const result = await port.get({ ownerId, url, maxChars }, signal)
    signal.throwIfAborted()
    return result
  } catch (error) {
    signal.throwIfAborted()
    return { error: `请求失败：${error instanceof Error ? error.name : '未知错误'}` }
  }
}

/** 参数归一与批量结果契约属于共享工具；网络请求和公网授权只由可信 Host 提供。 */
export function createHttpGetTool(port: HttpGetPort): ToolDefinition {
  return {
    definition: { name: 'http_get', schema: { type: 'function', function: { name: 'http_get',
      description: '读取公网 URL 正文；单次最多并行读取 5 个 URL，不跟随重定向。',
      parameters: { type: 'object', properties: {
        url: { type: 'string' }, urls: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 5, uniqueItems: true },
        max_chars: { type: 'integer' },
      }, anyOf: [{ required: ['url'], not: { required: ['urls'] } }, { required: ['urls'], not: { required: ['url'] } }] },
    } } },
    effect: 'read',
    validate(input) { return schema.safeParse(input) },
    async execute(input, scope) {
      const args = input as z.infer<typeof schema>
      const maxChars = typeof args.max_chars === 'number' && args.max_chars > 0
        ? Math.min(args.max_chars, maxBodyHard) : maxBody
      const urls = args.urls ?? (args.url ? [args.url] : [])
      if (!urls.length) return { kind: 'completed', successful: true, mutated: false, value: { error: '缺少 url 或 urls' } }
      if (urls.length > 1) {
        const results = await Promise.all(urls.map(async url => {
          const normalized = normalizeUrl(url)
          if ('error' in normalized) return normalized
          return fetchOne(port, scope.identity.ownerId, normalized.url, maxChars, scope.signal)
        }))
        scope.signal.throwIfAborted()
        return { kind: 'completed', successful: true, mutated: false, value: { results } }
      }
      const normalized = normalizeUrl(urls[0]!)
      if ('error' in normalized) return { kind: 'completed', successful: true, mutated: false, value: normalized }
      const result = await fetchOne(port, scope.identity.ownerId, normalized.url, maxChars, scope.signal)
      return { kind: 'completed', successful: true, mutated: false, value: result }
    },
  }
}
