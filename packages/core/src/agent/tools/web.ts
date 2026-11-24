import { attachmentFolderPathSchema } from './files.js'
import { z } from 'zod'
import { ProviderError } from '../providers/errors.js'
import { retryClock } from '../providers/retry.js'
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import type { ToolCall, ToolResult } from '../models.js'
import type { ProviderHttpResponse } from '../providers/contracts.js'
import type { ToolDefinition, ToolScope } from './contracts.js'

const schema = z.object({
  url: z.string().optional(),
  urls: z.array(z.string().min(1)).min(1).max(5).optional(),
  max_chars: z.number().int().optional(),
  headers: z.unknown().optional(),
}).passthrough().superRefine((value, context) => {
  if (Boolean(value.url) === Boolean(value.urls)) context.addIssue({ code: 'custom', message: '需提供 url 或 urls 其中之一' })
  if (value.url !== undefined && !value.url.trim()) context.addIssue({ code: 'custom', message: '缺少 url 或 urls' })
  if (value.urls && value.urls.some(url => !url.trim())) context.addIssue({ code: 'custom', message: 'urls 中每个元素都必须是非空字符串' })
  if (value.urls && new Set(value.urls).size !== value.urls.length) context.addIssue({ code: 'custom', message: 'urls 不能包含重复 URL' })
})

export interface HttpGetPort {
  /** Host 必须固定并校验公网 DNS 目标、拒绝重定向，且在 2 MiB 内返回原始正文。 */
  get(input: { ownerId: string; url: string; maxChars: number; headers?: Record<string, string> }, signal: AbortSignal): Promise<{
    status: number; headers: Readonly<Record<string, string>>; body: Uint8Array
  }>
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

const forbiddenRequestHeaders = new Set([
  'proxy-authorization', 'host', 'connection', 'keep-alive', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'cookie2',
])
const requestHeaderName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
function validateRequestHeaders(value: unknown, url: string): { headers: Record<string, string> } | { error: string } {
  if (value === undefined || value === null) return { headers: {} }
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'headers 必须是对象' }
  const entries = Object.entries(value)
  if (entries.length > 20) return { error: '自定义请求头最多 20 个' }
  const parsed = new URL(url)
  const headers: Record<string, string> = {}
  let totalBytes = 0
  for (const [rawName, rawValue] of entries) {
    if (!requestHeaderName.test(rawName)) return { error: '请求头名称格式无效' }
    const name = rawName.toLowerCase()
    if (Object.hasOwn(headers, name)) return { error: '请求头名称不能重复（不区分大小写）' }
    if (forbiddenRequestHeaders.has(name)) return { error: `不允许设置 ${rawName} 请求头` }
    if (parsed.protocol !== 'https:') return { error: '自定义请求头仅允许通过 HTTPS 发送' }
    if (typeof rawValue !== 'string') return { error: '请求头值必须是字符串' }
    const valueBytes = new TextEncoder().encode(rawValue).length
    if (valueBytes > 8192) return { error: '单个请求头值过长' }
    if (/[\u0000-\u001f\u007f]/u.test(rawValue)) return { error: '请求头值不能包含控制字符' }
    totalBytes += new TextEncoder().encode(rawName).length + valueBytes
    if (totalBytes > 16384) return { error: '自定义请求头总长度过长' }
    headers[name] = rawValue
  }
  return { headers }
}

const maxResponseBytes = 2 * 1024 * 1024
const maxExtractedPdfChars = 200_000
const minExtractedHtmlChars = 100
const blockedHtmlTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'nav', 'footer', 'header', 'aside', 'form'])
const blockHtmlTags = new Set(['article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'h1', 'h2', 'h3', 'h4', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul'])

function extractHtmlText(html: string): string {
  const fragment = parseFragment(html)
  const render = (node: DefaultTreeAdapterTypes.ChildNode): string => {
    if ('value' in node && node.nodeName === '#text') return node.value
    if (!('tagName' in node) || blockedHtmlTags.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return ''
    const content = node.childNodes.map(render).join('')
    if (node.tagName === 'a') {
      const href = node.attrs.find(attribute => attribute.name === 'href')?.value
      if (href && /^(?:https?:\/\/|mailto:)/iu.test(href) && !/[\p{Cc}\p{Cf}]/u.test(href)) return `[${content.trim() || href}](${href})`
    }
    return blockHtmlTags.has(node.tagName) ? `\n${content}\n` : content
  }
  return fragment.childNodes.map(render).join('').replace(/[\t\f\v ]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

async function extractPdfText(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  // PDF.js 会将输入缓冲区转移给解析 Worker；复制以免消费 Host 响应正文。
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  signal.throwIfAborted()
  const loading = getDocument({ data: bytes.slice(), useSystemFonts: true, disableFontFace: true, enableXfa: false, stopAtErrors: false, verbosity: 0 })
  const abortLoading = () => { void loading.destroy().catch(() => undefined) }
  signal.addEventListener('abort', abortLoading, { once: true })
  try {
    const document = await loading.promise
    let text = ''
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      signal.throwIfAborted()
      if (text.length >= maxExtractedPdfChars) break
      if (text.length) text += '\n\n'.slice(0, maxExtractedPdfChars - text.length)
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        for (const item of content.items) {
          if (!('str' in item)) continue
          const remaining = maxExtractedPdfChars - text.length
          if (remaining <= 0) break
          text += (item.str + (item.hasEOL ? '\n' : ' ')).slice(0, remaining)
        }
      } finally { page.cleanup() }
    }
    signal.throwIfAborted()
    return text.trim()
  } finally {
    signal.removeEventListener('abort', abortLoading)
    await loading.destroy().catch(() => undefined)
  }
}

async function httpGetResult(url: string, maxChars: number, response: Awaited<ReturnType<HttpGetPort['get']>>, signal: AbortSignal) {
  const contentType = (response.headers['content-type'] || '').split(';', 1)[0]!.trim().toLowerCase()
  if (response.body.byteLength > maxResponseBytes) return { error: '响应内容过大，已停止读取（上限 2MB）' }
  if (contentType === 'application/pdf') {
    try {
      const text = await extractPdfText(response.body, signal)
      return { status: response.status, url, content_type: contentType, body: text.slice(0, maxChars), truncated: text.length > maxChars, total_chars: text.length }
    } catch (error) {
      signal.throwIfAborted()
      return { error: `PDF 提取失败：${error instanceof Error ? error.name : '未知错误'}` }
    }
  }
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/iu.exec(response.headers['content-type'] || '')?.[1]
  let text: string
  try { text = new TextDecoder(charset || 'utf-8').decode(response.body) }
  catch { text = new TextDecoder('utf-8').decode(response.body) }
  const looksHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml'
    || (!contentType && /^\s*(?:<!doctype html|<html\b)/iu.test(text.slice(0, 100)))
  if (looksHtml) {
    text = extractHtmlText(text)
    if (text.length < minExtractedHtmlChars) return { status: response.status, url,
      error: '抓到了但没读出正文，可能是空页、错误页或纯 JS 渲染页面；请改用搜索或其他来源' }
  }
  return { status: response.status, url, content_type: contentType, body: text.slice(0, maxChars), truncated: text.length > maxChars, total_chars: text.length }
}

async function fetchOne(port: HttpGetPort, ownerId: string, url: string, maxChars: number, headers: Record<string, string>, signal: AbortSignal) {
  try {
    const response = await port.get({ ownerId, url, maxChars, ...(Object.keys(headers).length ? { headers } : {}) }, signal)
    signal.throwIfAborted()
    return await httpGetResult(url, maxChars, response, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ProviderError) {
      switch (error.code) {
        case 'timeout':
          return { error_code: 'timeout', error: error.options.timeoutPhase === 'connect'
            ? '连接目标网站超时，请改用其他来源'
            : '读取网页超时，请改用其他来源' }
        case 'network':
          return { error_code: 'network', error: '无法连接目标网站或连接中断，请改用其他来源' }
        case 'input_rejected':
          return { error_code: 'input_rejected', error: '目标地址或请求未通过公网访问校验' }
        case 'authentication':
          return { error_code: 'authentication', error: '出站代理认证失败，请联系管理员' }
      }
    }
    return { error: '网页请求失败，请改用其他来源' }
  }
}

/** 参数归一与批量结果契约属于共享工具；网络请求和公网授权只由可信 Host 提供。 */
export function createHttpGetTool(port: HttpGetPort): ToolDefinition {
  return {
    definition: { name: 'http_get', schema: { type: 'function', function: { name: 'http_get',
      description: '读取公网 URL 正文；单次最多并行读取 5 个 URL，不跟随重定向。',
      parameters: { type: 'object', properties: {
        url: { type: 'string' }, urls: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 5, uniqueItems: true },
        max_chars: { type: 'integer' }, headers: { type: 'object', additionalProperties: { type: 'string' } },
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
      const normalizedUrls = urls.map(normalizeUrl)
      if (args.headers && urls.length > 1) {
        const origins = normalizedUrls.map(value => {
          if ('error' in value) return null
          const parsed = new URL(value.url)
          return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`
        })
        if (origins.some(origin => origin === null) || new Set(origins).size !== 1) return {
          kind: 'completed', successful: true, mutated: false,
          value: { error: '使用自定义请求头的批量 URL 必须属于同一来源' },
        }
      }
      if (urls.length > 1) {
        const results = await Promise.all(urls.map(async (_, index) => {
          const normalized = normalizedUrls[index]!
          if ('error' in normalized) return normalized
          const headerResult = validateRequestHeaders(args.headers, normalized.url)
          if ('error' in headerResult) return headerResult
          return fetchOne(port, scope.identity.ownerId, normalized.url, maxChars, headerResult.headers, scope.signal)
        }))
        scope.signal.throwIfAborted()
        return { kind: 'completed', successful: true, mutated: false, value: { results } }
      }
      const normalized = normalizedUrls[0]!
      if ('error' in normalized) return { kind: 'completed', successful: true, mutated: false, value: normalized }
      const headerResult = validateRequestHeaders(args.headers, normalized.url)
      if ('error' in headerResult) return { kind: 'completed', successful: true, mutated: false, value: headerResult }
      const result = await fetchOne(port, scope.identity.ownerId, normalized.url, maxChars, headerResult.headers, scope.signal)
      return { kind: 'completed', successful: true, mutated: false, value: result }
    },
  }
}

const downloadSchema = z.object({
  folder_path: attachmentFolderPathSchema.optional(),
  url: z.string().min(1),
  file_name: z.string().nullable().optional(),
  space: z.enum(['personal', 'project', 'workspace']).nullable().optional(),
  project_id: z.number().int().safe().nullable().optional(),
}).strict()

type DownloadLocation = { folderPath?: string; space: 'personal' | 'project' | 'workspace' | null; projectId: number | null }
type FileDirectory = { projectId: number | null; workspaceDirectoryId: number | null }
type DownloadTarget = DownloadLocation & FileDirectory & { space: NonNullable<DownloadLocation['space']>; workspaceId: number | null }
type DownloadTargetError = { error: string; expected?: { space: string; project_id: number | null }; hint?: string }

/** 工作区绑定决定默认目标和显式 workspace 空间。 */
export async function resolveWebDownloadLocation(location: DownloadLocation, sources: {
  bound(): Promise<DownloadTarget | null>
}): Promise<DownloadTarget | DownloadTargetError> {
  const { space, projectId } = location
  const omitted = space === null && projectId === null
  if (omitted || space === 'workspace') {
    const target = await sources.bound()
    if (omitted && target) return target
    if (space === 'workspace') {
      if (!target) return { error: 'space=workspace 需要会话绑定工作区；未绑定会话请使用 personal/project。' }
      if (target.workspaceDirectoryId === null) return {
        error: '当前会话绑定的工作区没有可写入的文件目录（绑定的是项目或文件夹）。',
        expected: { space: target.space, project_id: target.projectId },
        hint: '省略目标位置参数即可写入当前工作区落点。',
      }
      return target
    }
  }
  return { space: space ?? (projectId === null ? 'personal' : 'project'), projectId, workspaceDirectoryId: null, workspaceId: null }
}

export interface WebDownloadPort {
  fixedDestination?: boolean
  allowFolderPath?: boolean
  /** 仅按 Host 批准的 owner、工作区授权和领域资源定位，结束读取事务再返回。 */
  prepare(location: DownloadLocation, scope: ToolScope): Promise<{
    capacity: number | null
    /** 未完整读取正文、取消或超限时不得提交；写入原子落点并再次确认容量。 */
    store(input: { name: string; mimeType: string; data: AsyncIterable<Uint8Array> }, scope: ToolScope, call: ToolCall): Promise<ToolResult>
  } | DownloadTargetError>
  /** 校验并固定公网 DNS 目标，不得自动跟随重定向。 */
  open(url: string, signal: AbortSignal): Promise<ProviderHttpResponse>
  extension(mimeType: string): string | null
  reconcile?(identity: ToolScope['identity'] & { roundId: string }, call: ToolCall): Promise<ToolResult>
}

function decodeFilename(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function downloadName(raw: string | null | undefined, url: string, headers: Readonly<Record<string, string>>, inferred: string | null): string {
  const disposition = /filename\*\s*=\s*[^']*''([^;]+)|filename\s*=\s*"?([^;"]+)/iu.exec(headers['content-disposition'] || '')
  const supplied = raw?.trim() || decodeFilename((disposition?.[1] || disposition?.[2] || '').trim())
    || decodeFilename(new URL(url).pathname)
  const last = supplied.replaceAll('\\', '/').replace(/\/+$/u, '').split('/').at(-1)!.trim()
  const clean = [...last].filter(char => char >= ' ' && !'<>:"|?*'.includes(char)).join('')
  const name = !clean || clean === '.' || clean === '..' ? 'download' : clean
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (extension.length <= 20 && /^[\p{L}\p{N}_-]+$/u.test(extension) && /[\p{L}\p{N}]/u.test(extension)) return `${name.slice(0, dot)}.${extension}`
  const fallback = inferred?.replace(/^\./u, '').slice(0, 20)
  return `${name}.${fallback && /^[A-Za-z0-9_-]+$/u.test(fallback) ? fallback : 'bin'}`
}

class DownloadCapacityExceeded extends Error {}
const downloadFailure = (error: string) => ({ kind: 'completed', successful: false, mutated: false, value: { error } } as const)
const downloadRetryDelays = [1000, 2000] as const

function retryableDownloadError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.options.retryable === true
    && (error.code === 'timeout' || error.code === 'network')
}

/** 下载流程只在授权的存储端口完成提交；网络流与文件正文不进入 Provider 上下文。 */
export function createWebDownloadTool(port: WebDownloadPort): ToolDefinition {
  return {
    definition: { name: 'web_download', schema: { type: 'function', function: {
      name: 'web_download',
      description: (port.fixedDestination ? '下载公网 URL 到个人文件。' : '下载公网 URL 到个人、项目或当前工作区文件目录。')
        + (port.allowFolderPath ? '可用 folder_path 指定已存在的相对子目录，省略时使用默认下载目录。' : ''),
      parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: {
        url: { type: 'string', minLength: 1 },
        file_name: { type: ['string', 'null'] },
        ...(port.allowFolderPath ? { folder_path: { type: 'string', description: '目标目录内已存在的相对子目录' } } : {}),
        ...(!port.fixedDestination ? {
        space: { type: ['string', 'null'], enum: ['personal', 'project', 'workspace', null] },
        project_id: { type: ['integer', 'null'] },
        } : {}),
      } },
    } } },
    effect: 'write',
    validate(input) { return downloadSchema.safeParse(input) },
    ...(port.reconcile ? { reconcile: (_input, identity, call) => port.reconcile!(identity, call) } : {}),
    async execute(input, scope, call) {
      const args = input as z.infer<typeof downloadSchema>
      if (args.folder_path !== undefined && !port.allowFolderPath) return downloadFailure('此下载工具不支持指定子目录')
      if (port.fixedDestination && (args.space != null || args.project_id != null))
        return downloadFailure('文件只能保存到下载目录')
      const candidate = args.url.trim()
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate) && !/^https?:\/\//iu.test(candidate)) return downloadFailure('非法 url')
      const normalized = normalizeUrl(candidate)
      if ('error' in normalized) return downloadFailure(normalized.error)
      if (args.project_id != null && args.space && args.space !== 'project')
        return downloadFailure(`space=${args.space} 不能提供 project_id`)
      scope.signal.throwIfAborted()
      if (port.reconcile) {
        const previous = await port.reconcile({ ...scope.identity, roundId: scope.roundId }, call)
        scope.signal.throwIfAborted()
        if (previous.kind === 'completed') return previous
      }
      const target = await port.prepare({ space: args.space ?? null, projectId: args.project_id ?? null, ...(args.folder_path === undefined ? {} : { folderPath: args.folder_path }) }, scope)
      if ('error' in target) return { kind: 'completed', successful: false, mutated: false, value: target }
      if (target.capacity !== null && (!Number.isSafeInteger(target.capacity) || target.capacity < 0))
        return downloadFailure('文件容量无法确认')
      scope.signal.throwIfAborted()
      for (let attempt = 0; ; attempt++) {
        let response: ProviderHttpResponse
        try { response = await port.open(normalized.url, scope.signal) }
        catch (error) {
          scope.signal.throwIfAborted()
          if (retryableDownloadError(error) && attempt < downloadRetryDelays.length) {
            await retryClock.sleep(downloadRetryDelays[attempt]!, scope.signal)
            continue
          }
          return downloadFailure('下载失败：网络超时或连接失败')
        }
        let retry = false
        try {
          scope.signal.throwIfAborted()
          if (response.status < 200 || response.status >= 300) return downloadFailure(`下载失败：远端返回 HTTP ${response.status}`)
          const capacity = target.capacity
          const capacityError = '下载文件超过大小限制'
          const remoteLength = response.headers['content-length'] ?? ''
          if (capacity !== null && /^\d+$/u.test(remoteLength) && Number(remoteLength) > capacity)
            return downloadFailure(capacityError)
          const mimeType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream'
          const name = downloadName(args.file_name, normalized.url, response.headers, port.extension(mimeType))
          async function* data() {
            let size = 0
            for await (const chunk of response.body) {
              scope.signal.throwIfAborted()
              size += chunk.byteLength
              if (capacity !== null && size > capacity) throw new DownloadCapacityExceeded()
              yield chunk
            }
            scope.signal.throwIfAborted()
          }
          try { return await target.store({ name, mimeType, data: data() }, scope, call) }
          catch (error) {
            if (error instanceof DownloadCapacityExceeded) return downloadFailure(capacityError)
            if (retryableDownloadError(error) && attempt < downloadRetryDelays.length) retry = true
            else throw error
          }
        } finally { await Promise.resolve().then(() => response.cancel()).catch(() => undefined) }
        if (retry) {
          await retryClock.sleep(downloadRetryDelays[attempt]!, scope.signal)
          continue
        }
      }
    },
  }
}
