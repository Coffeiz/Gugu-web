import { createMcpSafeFetch } from '../../mcp/safe-fetch.js'
import type { ProviderTransport } from '../providers/contracts.js'
import { z } from 'zod'
import { CoreError } from '../../contracts/index.js'

const searchResult = z.object({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
  displayName: z.string().min(1).max(500),
  summary: z.string().nullish(),
  version: z.string().nullish(),
  ownerHandle: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u),
  source: z.string().optional(),
  canonicalUrl: z.string().max(400).optional(),
  install: z.object({ kind: z.string(), reference: z.string().optional() }).passthrough().optional(),
}).passthrough()
const searchResponse = z.object({ results: z.array(z.unknown()).max(100) }).passthrough()
const resultSource = z.object({ source: z.string().optional(), install: z.object({ kind: z.string() }).passthrough().optional() }).passthrough()
const trendingSkill = z.object({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
  displayName: z.string().min(1).max(500),
  summary: z.string().nullish(),
  ownerHandle: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u),
  latestVersion: z.object({ version: z.string().max(100) }).nullish(),
  stats: z.object({ downloads: z.number().nonnegative().optional() }).passthrough().optional(),
}).passthrough()
const trendingResponse = z.object({ items: z.array(z.unknown()).max(100) }).passthrough()

function normalizeTrendingSkill(raw: unknown) {
  const parsed = trendingSkill.safeParse(raw)
  if (!parsed.success) throw new CoreError('storage_error', '技能目录响应格式无效')
  const item = parsed.data
  const reference = `${item.ownerHandle}/${item.slug}`
  const canonical = `/${item.ownerHandle}/skills/${item.slug}`
  return { slug: item.slug, name: item.displayName, description: item.summary ?? '',
    version: item.latestVersion?.version ?? null, owner: item.ownerHandle, reference,
    url: new URL(canonical, 'https://clawhub.ai').href, downloads: item.stats?.downloads ?? null }
}

/** 传输由宿主提供，负责固定目标校验、超时、响应大小和禁止未经校验的重定向。 */
export function createClawHubSearch(request: (url: string, signal: AbortSignal) => Promise<unknown>) {
  return async (query: string, signal: AbortSignal) => {
    const text = query.trim()
    if (!text || text.length > 200) throw new CoreError('invalid_request', '搜索内容长度无效')
    signal.throwIfAborted()
    const url = new URL('https://clawhub.ai/api/v1/search')
    url.searchParams.set('q', text)
    url.searchParams.set('limit', '20')
    const response = searchResponse.safeParse(await request(url.href, signal))
    signal.throwIfAborted()
    if (!response.success) throw new CoreError('storage_error', '技能目录响应格式无效')
    return response.data.results.flatMap(raw => {
      const source = resultSource.safeParse(raw)
      if (!source.success) throw new CoreError('storage_error', '技能目录响应格式无效')
      if ((source.data.source && source.data.source !== 'clawhub')
        || (source.data.install && source.data.install.kind !== 'clawhub')) return []
      const result = searchResult.safeParse(raw)
      if (!result.success) throw new CoreError('storage_error', '技能目录响应格式无效')
      const item = result.data
      const reference = `${item.ownerHandle}/${item.slug}`
      const canonical = `/${item.ownerHandle}/skills/${item.slug}`
      if (item.canonicalUrl !== undefined && item.canonicalUrl !== canonical)
        throw new CoreError('storage_error', '技能目录来源不一致')
      if (item.install?.kind === 'clawhub' && item.install.reference !== undefined
        && item.install.reference.replace(/^@/u, '') !== reference)
        throw new CoreError('storage_error', '技能目录来源不一致')
      return [{ slug: item.slug, name: item.displayName, description: item.summary ?? '', version: item.version ?? null,
        owner: item.ownerHandle, reference, url: new URL(canonical, 'https://clawhub.ai').href }]
    })
  }
}

/** 复用受限网络传输，避免搜索跟随未校验的重定向或读取过大响应。 */
export function createClawHubSearchWithTransport(transport: ProviderTransport) {
  const safeFetch = createMcpSafeFetch(transport, { timeoutMs: 15_000, maxResponseBytes: 1_000_000 })
  return createClawHubSearch(async (url, signal) => {
    const response = await safeFetch(url, { signal })
    if (!response.ok) throw new CoreError('storage_error', '技能目录暂时不可用')
    try { return await response.json() }
    catch { throw new CoreError('storage_error', '技能目录响应格式无效') }
  })
}

/** 从 ClawHub 官方 trending 排名读取可安装技能，隐藏被标记为可疑的条目。 */
export function createClawHubTrending(request: (url: string, signal: AbortSignal) => Promise<unknown>) {
  return async (signal: AbortSignal) => {
    signal.throwIfAborted()
    const url = new URL('https://clawhub.ai/api/v1/skills')
    url.searchParams.set('sort', 'trending')
    url.searchParams.set('limit', '12')
    url.searchParams.set('nonSuspiciousOnly', 'true')
    const response = trendingResponse.safeParse(await request(url.href, signal))
    signal.throwIfAborted()
    if (!response.success) throw new CoreError('storage_error', '技能目录响应格式无效')
    return response.data.items.flatMap(raw => {
      const source = resultSource.safeParse(raw)
      if (!source.success) throw new CoreError('storage_error', '技能目录响应格式无效')
      if ((source.data.source && source.data.source !== 'clawhub')
        || (source.data.install && source.data.install.kind !== 'clawhub')) return []
      return [normalizeTrendingSkill(raw)]
    })
  }
}

/** 复用受限网络传输，避免热门列表绕过宿主 URL、超时和响应大小校验。 */
export function createClawHubTrendingWithTransport(transport: ProviderTransport) {
  const safeFetch = createMcpSafeFetch(transport, { timeoutMs: 15_000, maxResponseBytes: 1_000_000 })
  return createClawHubTrending(async (url, signal) => {
    const response = await safeFetch(url, { signal })
    if (!response.ok) throw new CoreError('storage_error', '技能目录暂时不可用')
    try { return await response.json() }
    catch { throw new CoreError('storage_error', '技能目录响应格式无效') }
  })
}
