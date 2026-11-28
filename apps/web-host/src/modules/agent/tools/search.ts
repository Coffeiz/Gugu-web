import { createHash } from 'node:crypto'
import { decryptByokCredential } from '../../byok/crypto.js'
import { type ByokCredential } from '../../byok/store.js'
import type { Pool } from 'pg'
import { imageSize } from 'image-size'
import { loadImage } from '@napi-rs/canvas'
import { CompiledQuery, type Transaction } from 'kysely'
import type { Database, SqlDataRuntime } from '@gugu/core/data'
import { openLocalFile } from '@gugu/fs/node'
import { isOwnedFilePath } from '../../files/store.js'
import { adminSearchTestSettings } from '../../admin/search.js'
import { deepResearchProbe, normalizedApiKey, similarImageProbe, type ProviderTransport } from '@gugu/core/providers'
import type { RunIdentity } from '@gugu/core/agent'
import type { ToolScope } from '@gugu/core/tools'
import { MAX_DESKTOP_SEARCH_IMAGE_BYTES as MAX_SEARCH_IMAGE_BYTES, type DesktopDeepResearchInput, type DesktopSimilarImageInput } from '@gugu/core/agent/search-contracts'
import type { SafeEgressReadSettings } from '@gugu/core/preferences/safe-egress'
import { createAgentHttpGetPort, createDeepResearchTool, createDurableAgentPaidSearch, createSimilarImageSearchTool, createWebSearchTool, type HttpGetPort, type ToolDefinition } from '@gugu/core/tools'
import { dateKeyInTimeZone, startOfDateKeyInTimeZone } from '../../../shared/date-time.js'
import { createPublicAgentEgress } from '../../../adapters/network/safe-egress-proxy.js'
import type { WebAgentBinding } from '../run/reconstruct.js'

export { createAgentHttpGetPort as createWebAgentHttpGetPort } from '@gugu/core/tools'

interface DesktopRemoteSearchOptions {
  core: SqlDataRuntime
  pool: Pick<Pool, 'query'>
  schemaApplied: boolean
  readConfig(): unknown
  environment: Readonly<Record<string, string | undefined>>
  keyForVersion(version: number): string
  timezone: string
  readSafeEgress(): SafeEgressReadSettings
  secretKey: string
  digest(value: unknown): string
  imageStorageRoot?: string
}

type DesktopSearchImage = { id: string; bytes: Buffer }

async function desktopRemoteSearchPorts(options: DesktopRemoteSearchOptions, ownerId: string, operationId: string, uploadedImage?: DesktopSearchImage, reconcileOnly = false) {
  const identity: RunIdentity = { ownerId, sessionId: '1', runId: operationId }
  const egress = createPublicAgentEgress(options.readSafeEgress, options.secretKey)
  if (!reconcileOnly) {
    try { egress.assertConfigured() }
    catch { return {} }
  }
  return createPaidSearchPorts({
    identity, digest: options.digest, withTransport: egress.withTransport, reconcileOnly,
    research: {
      pool: options.pool, schemaApplied: options.schemaApplied, readConfig: options.readConfig,
      environment: options.environment, keyForVersion: options.keyForVersion, timezone: options.timezone,
      ...(options.imageStorageRoot ? { imageStorageRoot: options.imageStorageRoot } : {}),
      uploadedImage,
      durable: {
        core: options.core,
        async authorize(_tx, candidate, signal) {
          signal.throwIfAborted()
          return candidate.ownerId === ownerId && candidate.sessionId === '1' && candidate.runId === operationId
        },
      },
    },
  })
}

export function createDesktopRemoteSearchAvailability(
  options: DesktopRemoteSearchOptions, capability: 'deepResearch' | 'similarImageSearch',
) {
  return async (ownerId: string) => Boolean((await desktopRemoteSearchPorts(options, ownerId, 'availability'))[capability])
}

function desktopSearchScope(identity: RunIdentity, signal: AbortSignal): ToolScope {
  return {
    identity, roundId: 'desktop-remote-search', signal, resolution: null,
    async execute() { throw new Error('远程搜索不执行本机工具请求') },
  }
}

/** 桌面请求经认证后仍复用 Web 的 Provider、BYOK、额度与持久搜索收据。 */
export function createDesktopRemoteDeepResearchExecutor(options: DesktopRemoteSearchOptions) {
  return async (ownerId: string, input: DesktopDeepResearchInput, signal: AbortSignal) => {
    const ports = await desktopRemoteSearchPorts(options, ownerId, input.operation_id, undefined, input.reconcile_only)
    const tool = ports.deepResearch
    if (!tool) return input.reconcile_only ? { kind: 'unknown' as const }
      : { kind: 'completed', successful: false, mutated: false, value: { error: '深度研究暂不可用，请检查服务器搜索配置' } }
    const toolInput = { query: input.query, ...(input.max_results === undefined ? {} : { max_results: input.max_results }),
      ...(input.depth === undefined ? {} : { depth: input.depth }) }
    const scope = desktopSearchScope({ ownerId, sessionId: '1', runId: input.operation_id }, signal)
    const call = { id: input.operation_id, name: 'deep_research', input: toolInput }
    signal.throwIfAborted()
    if (input.reconcile_only) return tool.reconcile?.(toolInput, { ...scope.identity, roundId: scope.roundId }, call) ?? { kind: 'unknown' }
    return tool.execute(toolInput, scope, call)
  }
}

/** 图片 URL 沿用 Web 的安全出站、BYOK、每日额度和幂等收据。 */
export function createDesktopRemoteSimilarImageExecutor(options: DesktopRemoteSearchOptions) {
  return async (ownerId: string, input: DesktopSimilarImageInput, signal: AbortSignal) => {
    const bytes = 'image_base64' in input ? Buffer.from(input.image_base64, 'base64') : undefined
    const uploadedImage = bytes ? { bytes, id: createHash('sha256').update(bytes).digest('hex') } : undefined
    const ports = await desktopRemoteSearchPorts(options, ownerId, input.operation_id, uploadedImage, input.reconcile_only)
    const tool = ports.similarImageSearch
    if (!tool) return input.reconcile_only ? { kind: 'unknown' as const }
      : { kind: 'completed', successful: false, mutated: false, value: { error: '相似图片搜索暂不可用，请检查服务器搜索配置' } }
    const toolInput = {
      ...('image_url' in input ? { image_url: input.image_url } : { attach_id: 'image_digest' in input ? input.image_digest : uploadedImage!.id }),
      ...(input.max_results === undefined ? {} : { max_results: input.max_results }),
    }
    const scope = desktopSearchScope({ ownerId, sessionId: '1', runId: input.operation_id }, signal)
    const call = { id: input.operation_id, name: 'similar_image_search', input: toolInput }
    signal.throwIfAborted()
    if (input.reconcile_only) return tool.reconcile?.(toolInput, { ...scope.identity, roundId: scope.roundId }, call) ?? { kind: 'unknown' }
    return tool.execute(toolInput, scope, call)
  }
}

interface PaidSearchSettings {
  pool: Pick<Pool, 'query'>
  schemaApplied: boolean
  readConfig(): unknown
  environment: Readonly<Record<string, string | undefined>>
  keyForVersion(version: number): string
  timezone: string
  imageStorageRoot?: string
  uploadedImage?: DesktopSearchImage
  durable?: {
    core: SqlDataRuntime
    authorize(tx: Transaction<Database>, identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  }
}

/** 按可信的模型绑定公开厂商 Schema，出站策略在每次执行时读取。 */
export async function createWebAgentSearchPorts(options: {
  identity: RunIdentity
  binding: Pick<WebAgentBinding, 'resolve' | 'selection'>
  readSafeEgress(): SafeEgressReadSettings
  secretKey: string
  digest(value: unknown): string
  egress?: Pick<ReturnType<typeof createPublicAgentEgress>, 'assertConfigured' | 'withTransport'>
  research?: PaidSearchSettings
}): Promise<{ httpGet?: HttpGetPort; webSearch?: ToolDefinition; deepResearch?: ToolDefinition; similarImageSearch?: ToolDefinition }> {
  const identity = Object.freeze({ ...options.identity })
  const modelIdentity = options.binding.selection.modelIdentity
  if (!modelIdentity) return {}
  const egress = options.egress ?? createPublicAgentEgress(options.readSafeEgress, options.secretKey)
  let httpGet: HttpGetPort | undefined
  try {
    egress.assertConfigured()
    httpGet = createAgentHttpGetPort(egress)
  } catch { return {} /* 安全出站配置不可用时关闭所有公网工具。 */ }
  let selected
  try {
    selected = await options.binding.resolve(identity, modelIdentity, new AbortController().signal)
  } catch { return httpGet ? { httpGet } : {} }
  if (selected.modelIdentity !== modelIdentity) return httpGet ? { httpGet } : {}

  const { withTransport } = egress

  const webSearch = createWebSearchTool(selected.config, { digest: options.digest, withTransport })
  const paid = options.research ? await createPaidSearchPorts({
    identity, digest: options.digest, withTransport, research: options.research,
  }) : {}
  return { httpGet, ...(webSearch ? { webSearch } : {}), ...paid }
}

async function createPaidSearchPorts(options: {
  identity: RunIdentity
  digest(value: unknown): string
  withTransport: ReturnType<typeof createPublicAgentEgress>['withTransport']
  research: PaidSearchSettings
  reconcileOnly?: boolean
}): Promise<{ deepResearch?: ToolDefinition; similarImageSearch?: ToolDefinition }> {
  const { identity, withTransport } = options
  const ports: { deepResearch?: ToolDefinition; similarImageSearch?: ToolDefinition } = {}
  const bound = options.research
  if (!bound.schemaApplied) return ports
  try {
    const ready = await bound.pool.query<{ ready: boolean }>("SELECT to_regclass('search_usage') IS NOT NULL AS ready")
    if (ready.rows[0]?.ready !== true) return ports
  } catch { return ports }

  const matches = (candidate: RunIdentity) => candidate.ownerId === identity.ownerId
    && candidate.sessionId === identity.sessionId && candidate.runId === identity.runId
  const credentials = async (capability: 'deep_research' | 'similar_image_search') => {
    const doc = searchConfiguration(bound.readConfig(), bound.environment)
    const search = doc.search
    const quota = doc.quota
    const config = adminSearchTestSettings(doc)
    const override = await bound.pool.query<Pick<ByokCredential, 'provider' | 'encrypted_value' | 'nonce' | 'encrypted_data_key' | 'key_version'>>(
      'SELECT provider, encrypted_value, nonce, encrypted_data_key, key_version FROM user_provider_credentials WHERE user_id=$1 AND capability=$2 AND enabled IS TRUE ORDER BY id LIMIT 1',
      [identity.ownerId, capability],
    )
    const credential = override.rows[0]
    const provider = capability === 'deep_research' ? credential?.provider || config.deep_research_provider || 'tavily'
      : search.similar_image_provider ?? 'baidu_qianfan'
    if (capability === 'deep_research' ? !['tavily', 'baidu', 'you'].includes(String(provider)) : provider !== 'baidu_qianfan') return null
    const platformKeys = {
      tavily: config.tavily_api_key, baidu: config.deep_research_baidu_api_key, you: config.deep_research_you_api_key,
      baidu_qianfan: config.baidu_qianfan_api_key,
    }
    const key = credential ? decryptByokCredential(credential, bound.keyForVersion) : platformKeys[provider as keyof typeof platformKeys]
    if (!key) return null
    const image = capability === 'similar_image_search'
    const dailyLimit = Object.hasOwn(image ? search : quota, image ? 'similar_image_limit_daily' : 'default_search_limit_daily')
      ? configInteger(image ? search.similar_image_limit_daily : quota.default_search_limit_daily, null)
      : image ? 10 : null
    return { provider: String(provider), key: normalizedApiKey(key), dailyLimit,
      maxResults: configInteger(image ? search.similar_image_default_count : search.max_results, image ? 15 : 5) || (image ? 15 : 5),
      timeoutMs: Math.min(60, Math.max(5, configInteger(search.similar_image_timeout_seconds, 20) ?? 20)) * 1000,
    }
  }

  function dayStart(now: Date) { return startOfDateKeyInTimeZone(dateKeyInTimeZone(now, bound.timezone), bound.timezone) }
  const usage = async (tx: Transaction<Database>, image: boolean, start: Date) => {
    type Status = { search_limit_daily: number | null; used: string }
    const statement = `SELECT u.search_limit_daily,
      (SELECT count(*) FROM search_usage s WHERE s.user_id=u.id AND s.created_at >= $2
        AND (NOT $3::boolean OR s.query LIKE '[similar-image]%')) AS used
      FROM users u WHERE u.id=$1 AND u.is_active IS TRUE AND coalesce(u.account_status,'active')='active'`
    const values = [identity.ownerId, start, image]
    const status = await tx.getExecutor().executeQuery<Status>(CompiledQuery.raw(statement, values))
    return status.rows[0] ?? null
  }

  async function available(capability: 'deep_research' | 'similar_image_search') {
    try { return Boolean((await credentials(capability))?.key) }
    catch { return false }
  }

  async function recordUsage(tx: Transaction<Database>, owner: string, query: string) {
    const values = [owner, [...query].slice(0, 500).join('')]
    await tx.getExecutor().executeQuery(CompiledQuery.raw(
      'INSERT INTO search_usage (user_id,query,created_at) VALUES ($1,$2,clock_timestamp())', values))
  }

  const durable = bound.durable
  if (!durable?.core.receipts) return ports
  const { core, authorize } = durable
  function reservation(candidate: RunIdentity, signal: AbortSignal, image: boolean, dailyLimit: number | null) {
    const now = new Date(), start = dayStart(now)
    const label = image ? '相似图搜索' : '深度研究'
    return {
      reservationSince: new Date(Math.min(start.getTime(), now.getTime() - 120_000)).toISOString(),
      async reserve(tx: Transaction<Database>, pending: number) {
        if (!await authorize(tx, candidate, signal)) return `当前运行无权进行${label}`
        const user = await usage(tx, image, start)
        if (!user) return `当前运行无权进行${label}`
        const ownerLimit = user.search_limit_daily
        const limit = ownerLimit !== null && image ? Math.min(ownerLimit, dailyLimit ?? ownerLimit) : ownerLimit ?? dailyLimit
        return limit !== null && Number(user.used) + pending >= limit
          ? `今天的${label}次数已用完（上限 ${limit} 次/天）${image ? '' : '；普通查找可用 web_search'}` : null
      },
    }
  }
  if (options.reconcileOnly || await available('deep_research')) ports.deepResearch = createDeepResearchTool(createDurableAgentPaidSearch(core, {
    name: 'deep_research', matches,
    async prepare(input, scope) {
      const { signal } = scope
      signal.throwIfAborted()
      try {
        const current = await credentials('deep_research')
        if (!current?.key) return { error: '尚未配置深度研究 API Key' }
        return {
          ...reservation(scope.identity, signal, false, current.dailyLimit),
          request(requestSignal) {
            return withTransport(requestSignal, transport => deepResearchProbe(current.provider, current.key,
              input.query, input.maxResults ?? current.maxResults, input.depth, { transport, digest: options.digest }, requestSignal))
          },
        }
      } catch {
        signal.throwIfAborted()
        return { error: '深度研究失败：暂时不可用，请稍后重试' }
      }
    },
    recordUsage: (tx, owner, input) => recordUsage(tx, owner, input.query),
  }))

  const storageRoot = bound.imageStorageRoot
  async function imageAttachmentsReady() {
    try {
      const target = await bound.pool.query<{ ready: boolean }>("SELECT to_regclass('chat_attachments') IS NOT NULL AS ready")
      return target.rows[0]?.ready === true
    } catch { return false }
  }
  if (options.reconcileOnly || (storageRoot && await available('similar_image_search') && await imageAttachmentsReady())) ports.similarImageSearch = createSimilarImageSearchTool(createDurableAgentPaidSearch(core, {
    name: 'similar_image_search', matches,
    async prepare(input, scope) {
      const { signal } = scope
      signal.throwIfAborted()
      try {
        const current = await credentials('similar_image_search')
        if (!current?.key) return { error: '相似图搜索尚未配置或未启用，请管理员先在 Admin 配置百度千帆 API Key' }
        return {
          ...reservation(scope.identity, signal, true, current.dailyLimit),
          async request(requestSignal) {
            let image: SearchImage
            try {
              const uploaded = bound.uploadedImage
              if (uploaded && uploaded.id === input.attachmentId) image = { bytes: uploaded.bytes }
              else if (input.attachmentId && storageRoot)
                image = await readOwnedSearchImage(bound.pool, storageRoot, identity.ownerId, input.attachmentId, requestSignal)
              else if (input.attachmentId) return { error: '找不到这个图片附件，可能已过期' }
              else image = await withTransport(requestSignal, transport => readPublicSearchImage(transport, input.url, requestSignal))
              if ('error' in image) return image
              const error = await verifySearchImage(image.bytes, requestSignal)
              if (error) return { error }
              const permitted = await core.db.transaction().execute(tx => authorize(tx, scope.identity, requestSignal))
              if (!permitted) return { error: '当前运行无权进行相似图搜索' }
            } catch {
              // 此处尚未请求付费 Provider，可安全释放用量预留。
              return requestSignal.aborted ? { error: '相似图搜索已取消' } : imageSearchError('upstream_error')
            }
            if (requestSignal.aborted) return { error: '相似图搜索已取消' }
            const count = Math.min(20, Math.max(1, input.maxResults ?? current.maxResults))
            const value = await withTransport(requestSignal, transport => similarImageProbe(current.key, image.bytes, count,
              { transport, digest: options.digest }, requestSignal, current.timeoutMs, { preserveUnknownOutcome: true }))
            if (typeof value.error_code === 'string') return imageSearchError(value.error_code)
            return Array.isArray(value.results) && value.results.length === 0 ? { ...value, note: '没有找到相似结果' } : value
          },
        }
      } catch {
        signal.throwIfAborted()
        return imageSearchError('upstream_error')
      }
    },
    recordUsage: (tx, owner) => recordUsage(tx, owner, '[similar-image]'),
  }))
  return ports
}

const MAX_SEARCH_IMAGE_PIXELS = 16_000_000
type SearchImage = { bytes: Buffer } | { error: string }
const tooLarge = { error: '图片超过百度接口的 4MB 限制' }

async function readOwnedSearchImage(pool: Pick<Pool, 'query'>, root: string, owner: string, attachmentId: string, signal: AbortSignal): Promise<SearchImage> {
  const result = await pool.query<{ kind: string; ext: string; size: string | number; storage_key: string }>(
    "SELECT kind,ext,size,storage_key FROM chat_attachments WHERE user_id=$1 AND attach_id=$2 AND state IN ('draft','attached')", [owner, attachmentId],
  )
  signal.throwIfAborted()
  const attachment = result.rows[0]
  if (!attachment || !isOwnedFilePath(owner, attachment.storage_key)) return { error: '找不到这个图片附件，可能已过期' }
  if (attachment.kind !== 'image') return { error: '指定附件不是图片' }
  if (!['jpg', 'jpeg', 'png'].includes(attachment.ext.toLowerCase())) return { error: '相似图搜索只支持 JPG 和 PNG 图片' }
  if (Number(attachment.size) > MAX_SEARCH_IMAGE_BYTES) return tooLarge
  const opened = await openLocalFile(root, attachment.storage_key)
  if (!opened) return { error: '找不到这个图片附件，可能已过期' }
  try {
    if (opened.size > MAX_SEARCH_IMAGE_BYTES) return tooLarge
    if (opened.size !== Number(attachment.size)) return { error: '图片内容无法解析' }
    const bytes = Buffer.alloc(opened.size + 1)
    const result = await opened.handle.read(bytes, 0, bytes.length, 0)
    signal.throwIfAborted()
    if (result.bytesRead !== opened.size) return { error: '图片内容无法解析' }
    return { bytes: bytes.subarray(0, opened.size) }
  } finally { await opened.handle.close() }
}

async function readPublicSearchImage(transport: ProviderTransport, rawUrl: string, signal: AbortSignal): Promise<SearchImage> {
  const invalid = { error: '网络图片下载失败，无法进行相似图搜索' }
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//iu.test(rawUrl) ? rawUrl : `https://${rawUrl}`
    const response = await transport.request({ url, method: 'GET', headers: {}, timeoutMs: 30_000 }, signal)
    try {
      if (response.status < 200 || response.status >= 300) return invalid
      if (Number(response.headers['content-length'] ?? 0) > MAX_SEARCH_IMAGE_BYTES) return tooLarge
      const chunks: Uint8Array[] = []
      let total = 0
      for await (const chunk of response.body) {
        signal.throwIfAborted()
        total += chunk.byteLength
        if (total > MAX_SEARCH_IMAGE_BYTES) return tooLarge
        chunks.push(chunk)
      }
      signal.throwIfAborted()
      return { bytes: Buffer.concat(chunks, total) }
    } finally { await response.cancel() }
  } catch {
    signal.throwIfAborted()
    return invalid
  }
}

export async function verifySearchImage(bytes: Buffer, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted()
  if (bytes.length > MAX_SEARCH_IMAGE_BYTES) return tooLarge.error
  try {
    const header = imageSize(bytes)
    if (header.type !== 'jpg' && header.type !== 'png') return '图片实际格式不是 JPG 或 PNG'
    if (!header.width || !header.height || header.width * header.height > MAX_SEARCH_IMAGE_PIXELS) return '图片尺寸超出解析限制'
    const image = await loadImage(bytes)
    signal.throwIfAborted()
    if (!image.width || !image.height) return '图片内容无法解析'
    return null
  } catch {
    signal.throwIfAborted()
    return '图片内容无法解析'
  }
}

function imageSearchError(code: string) {
  const messages: Record<string, string> = {
    invalid_api_key: '百度相似图搜索 API Key 格式无效，请使用服务提供的 ASCII API Key',
    upstream_timeout: '相似图搜索请求超时，请稍后重试',
    upstream_auth: '百度相似图搜索鉴权失败，请管理员检查 API Key',
    upstream_rate_limited: '百度相似图搜索调用频率或额度已用尽，请稍后重试',
    upstream_unavailable: '百度相似图搜索暂时不可用，请稍后重试',
    upstream_error: '相似图搜索网络连接失败，请稍后重试',
  }
  return { error_code: code === 'upstream_unavailable' ? 'upstream_error' : code,
    error: messages[code] ?? messages.upstream_error! }
}

function searchConfiguration(document: unknown, environment: Readonly<Record<string, string | undefined>>) {
  const env = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key.toUpperCase(), value]))
  function section(name: 'search' | 'quota') {
    const prefix = name.toUpperCase()
    const nested = env[prefix] === undefined ? {} : asRecord(JSON.parse(env[prefix]))
    const setting = Object.fromEntries(Object.entries(env).flatMap(([key, value]) =>
      key.startsWith(`${prefix}__`) && value !== undefined ? [[key.slice(prefix.length + 2).toLowerCase(), value]] : []))
    return { ...nested, ...setting, ...asRecord(asRecord(document)[name]) }
  }
  return { search: section('search'), quota: section('quota') }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function configInteger(value: unknown, defaultValue: number | null) {
  if (value == null || value === '') return defaultValue
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim())) ? Number(value) : NaN
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error('搜索配置无效')
  return numeric
}
