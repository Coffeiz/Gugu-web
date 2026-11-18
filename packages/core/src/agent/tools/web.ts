import { z } from 'zod'
import type { ToolCall, ToolResult } from '../models.js'
import type { ProviderHttpResponse } from '../providers/contracts.js'
import type { ToolDefinition, ToolScope } from './contracts.js'

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

const downloadSchema = z.object({
  url: z.string().min(1),
  file_name: z.string().nullable().optional(),
  space: z.enum(['personal', 'project', 'workspace']).nullable().optional(),
  project_id: z.number().int().safe().nullable().optional(),
  folder_id: z.number().int().safe().nullable().optional(),
}).strict()

type DownloadLocation = { space: 'personal' | 'project' | 'workspace' | null; projectId: number | null; folderId: number | null }
type FileDirectory = { projectId: number | null; workspaceDirectoryId: number | null }
type DownloadTarget = DownloadLocation & FileDirectory & { space: NonNullable<DownloadLocation['space']>; workspaceId: number | null }
type DownloadTargetError = { error: string; expected?: { space: string; project_id: number | null; folder_id: number | null }; hint?: string }

/** 工作区绑定只决定默认目标和显式 workspace 空间，文件夹推断仍以 owner 限定的查询为准。 */
export async function resolveWebDownloadLocation(location: DownloadLocation, sources: {
  bound(): Promise<DownloadTarget | null>
  folder(id: number): Promise<FileDirectory | null>
}): Promise<DownloadTarget | DownloadTargetError> {
  const { space, projectId, folderId } = location
  const omitted = space === null && projectId === null && folderId === null
  if (omitted || space === 'workspace') {
    const target = await sources.bound()
    if (omitted && target) return target
    if (space === 'workspace') {
      if (!target) return { error: 'space=workspace 需要会话绑定工作区；未绑定会话请使用 personal/project。' }
      if (target.workspaceDirectoryId === null) return {
        error: '当前会话绑定的工作区没有可写入的文件目录（绑定的是项目或文件夹）。',
        expected: { space: target.space, project_id: target.projectId, folder_id: target.folderId },
        hint: '省略目标位置参数即可写入当前工作区落点。',
      }
      return { ...target, folderId }
    }
  }
  if (space === null && projectId === null && folderId !== null) {
    const folder = await sources.folder(folderId)
    if (!folder) return { error: '文件夹不存在' }
    const inferredSpace = folder.workspaceDirectoryId !== null ? 'workspace' : folder.projectId !== null ? 'project' : 'personal'
    return { ...folder, space: inferredSpace, folderId, workspaceId: null }
  }
  return { space: space ?? (projectId === null ? 'personal' : 'project'), projectId, folderId, workspaceDirectoryId: null, workspaceId: null }
}

export interface WebDownloadPort {
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

/** 下载流程只在授权的存储端口完成提交；网络流与文件正文不进入 Provider 上下文。 */
export function createWebDownloadTool(port: WebDownloadPort): ToolDefinition {
  return {
    definition: { name: 'web_download', schema: { type: 'function', function: {
      name: 'web_download',
      description: '下载公网 URL 到个人、项目或当前工作区文件目录。',
      parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: {
        url: { type: 'string', minLength: 1 },
        file_name: { type: ['string', 'null'] },
        space: { type: ['string', 'null'], enum: ['personal', 'project', 'workspace', null] },
        project_id: { type: ['integer', 'null'] },
        folder_id: { type: ['integer', 'null'] },
      } },
    } } },
    effect: 'write',
    validate(input) { return downloadSchema.safeParse(input) },
    ...(port.reconcile ? { reconcile: (_input, identity, call) => port.reconcile!(identity, call) } : {}),
    async execute(input, scope, call) {
      const args = input as z.infer<typeof downloadSchema>
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
      const target = await port.prepare({ space: args.space ?? null, projectId: args.project_id ?? null, folderId: args.folder_id ?? null }, scope)
      if ('error' in target) return { kind: 'completed', successful: false, mutated: false, value: target }
      if (target.capacity !== null && (!Number.isSafeInteger(target.capacity) || target.capacity < 0))
        return downloadFailure('文件容量无法确认')
      scope.signal.throwIfAborted()
      let response: ProviderHttpResponse
      try { response = await port.open(normalized.url, scope.signal) }
      catch {
        scope.signal.throwIfAborted()
        return downloadFailure('下载失败：网络超时或连接失败')
      }
      try {
        scope.signal.throwIfAborted()
        if (response.status < 200 || response.status >= 300) return downloadFailure(`下载失败：远端返回 HTTP ${response.status}`)
        const capacity = target.capacity
        const capacityError = '下载内容超过当前用户可用存储空间'
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
          throw error
        }
      } finally { await Promise.resolve().then(() => response.cancel()).catch(() => undefined) }
    },
  }
}
