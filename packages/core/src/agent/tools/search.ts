import type { JsonObject, ProviderConfig, ProviderDriverDependencies } from '../providers/contracts.js'
import { createHash } from 'node:crypto'
import { sql, type Transaction } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import { databaseTime } from '../../data/codec.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import type { Database } from '../../data/schema.js'
import { providerSearchSchema, searchProvider, supportsProviderSearch } from '../providers/search.js'
import type { RunIdentity, ToolCall, ToolResult } from '../models.js'
import type { ToolDefinition, ToolScope } from './contracts.js'
import { z } from 'zod'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 厂商原生搜索 Schema 只用这些关键字。公开声明与校验共用同一份快照。 */
function matchesNativeSearchSchema(schema: unknown, value: unknown): boolean {
  if (!object(schema)) return false
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  if (Array.isArray(schema.type)) return schema.type.some(type => matchesNativeSearchSchema({ ...schema, type }, value))
  switch (schema.type) {
    case 'null': return value === null
    case 'object': {
      if (!object(value)) return false
      const properties = object(schema.properties) ? schema.properties : {}
      if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(value, key))) return false
      return Object.entries(value).every(([key, item]) => Object.hasOwn(properties, key)
        ? matchesNativeSearchSchema(properties[key], item)
        : schema.additionalProperties !== false)
    }
    case 'array': return Array.isArray(value)
      && (typeof schema.minItems !== 'number' || value.length >= schema.minItems)
      && (typeof schema.maxItems !== 'number' || value.length <= schema.maxItems)
      && value.every(item => matchesNativeSearchSchema(schema.items, item))
    case 'string': {
      if (typeof value !== 'string') return false
      const length = [...value].length
      return (typeof schema.minLength !== 'number' || length >= schema.minLength)
        && (typeof schema.maxLength !== 'number' || length <= schema.maxLength)
        && (typeof schema.pattern !== 'string' || new RegExp(schema.pattern, 'u').test(value))
    }
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
      && (typeof schema.minimum !== 'number' || value >= schema.minimum)
      && (typeof schema.maximum !== 'number' || value <= schema.maximum)
    case 'boolean': return typeof value === 'boolean'
    default: return false
  }
}

/** 搜索 Schema、凭据及请求固定在同一可信运行绑定。 */
export function createWebSearchTool(
  config: ProviderConfig,
  run: Pick<ProviderDriverDependencies, 'digest'> & {
    withTransport<T>(signal: AbortSignal, execute: (transport: ProviderDriverDependencies['transport']) => Promise<T>): Promise<T>
  },
): ToolDefinition | undefined {
  if (config.web_search_enabled !== true || !config.api_key?.trim() || !supportsProviderSearch(config)) return undefined
  const selected = structuredClone(config)
  const parameters = providerSearchSchema(selected)
  return {
    definition: { name: 'web_search', schema: { type: 'function', function: {
      name: 'web_search',
      description: '使用当前模型 Provider 的原生联网搜索核对资料，调用可能产生费用。',
      parameters,
    } } },
    effect: 'read',
    validate(value) { return matchesNativeSearchSchema(parameters, value) ? { success: true, data: value } : { success: false } },
    async execute(input, scope) {
      const { signal } = scope
      signal.throwIfAborted()
      let value: JsonObject
      try {
        value = await run.withTransport(signal, transport => searchProvider(selected, input as JsonObject, {
          transport, digest: run.digest,
        }, signal))
      } catch {
        value = { error: '联网搜索暂时不可用，请稍后重试' }
      }
      signal.throwIfAborted()
      return { kind: 'completed', successful: !Object.hasOwn(value, 'error'), mutated: false, value }
    },
  }
}

const deepResearchSchema = z.object({
  query: z.string(),
  max_results: z.number().int().min(1).max(20).optional(),
  depth: z.enum(['basic', 'advanced']).optional(),
}).strip()

interface PaidSearchPort<Input> {
  search(input: Input, scope: ToolScope, call: ToolCall): Promise<ToolResult>
  reconcile?(input: Input, identity: RunIdentity & { roundId: string }, call: ToolCall): Promise<ToolResult>
}

type DeepResearchInput = { query: string; maxResults?: number; depth: 'basic' | 'advanced' }
export type DeepResearchPort = PaidSearchPort<DeepResearchInput>

function normalizedResearch(input: unknown): DeepResearchInput {
  const args = input as z.infer<typeof deepResearchSchema>
  return { query: args.query.trim(), maxResults: args.max_results, depth: args.depth ?? 'basic' }
}

const searchRejected = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })

/** 当前三个厂商均在一个请求中返回最终结果。 */
export function createDeepResearchTool(port: DeepResearchPort): ToolDefinition {
  return {
    definition: { name: 'deep_research', schema: { type: 'function', function: {
      name: 'deep_research',
      description: '阅读和研究外部资料，返回总结或引用。',
      parameters: { type: 'object', required: ['query'], properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: 20 },
        depth: { type: 'string', enum: ['basic', 'advanced'] },
      } },
    } } },
    effect: 'write',
    validate(input) { return deepResearchSchema.safeParse(input) },
    ...(port.reconcile ? { reconcile: (input: unknown, identity: RunIdentity & { roundId: string }, call: ToolCall) =>
      port.reconcile!(normalizedResearch(input), identity, call) } : {}),
    async execute(input, scope, call) {
      const normalized = normalizedResearch(input)
      if (!normalized.query) return searchRejected('需要提供搜索关键词 query')
      scope.signal.throwIfAborted()
      return port.search(normalized, scope, call)
    },
  }
}

/** 事务内保留额度并认领外呼，事务外请求 Provider，恢复只读取结果。 */
export function createDurableAgentPaidSearch<Input extends { maxResults?: number }>(core: SqlDataRuntime, options: {
  name: 'deep_research' | 'similar_image_search'
  matches(identity: RunIdentity): boolean
  prepare(input: Input, scope: ToolScope): Promise<{ error: string } | {
    reservationSince: string
    reserve(tx: Transaction<Database>, pending: number): Promise<string | null>
    request(signal: AbortSignal): Promise<JsonObject>
  }>
  recordUsage(tx: Transaction<Database>, ownerId: string, input: Input): Promise<void>
}): PaidSearchPort<Input> {
  const research = options.name === 'deep_research'
  const label = research ? '深度研究' : '相似图搜索'
  if (!core.receipts) throw new Error(`${label}需要持久操作收据`)
  const attemptMethod = `agent.${options.name}.attempt`
  const outcomeMethod = `agent.${options.name}.outcome`
  const countedAttempts = research ? [attemptMethod, 'agent.similar_image_search.attempt'] : [attemptMethod]
  const absent = new Error('搜索收据不存在')
  const pending = { pending: true }
  const settled = { pending: false }
  type Outcome = Extract<ToolResult, { kind: 'completed' }>
  class Refused extends Error {}

  function coordinate(identity: RunIdentity, roundId: string, call: ToolCall) {
    const context = dataContext(identity.ownerId)
    function id(method: string) {
      const hex = createHash('sha256').update(JSON.stringify([method, context.ownerId, identity.sessionId, identity.runId, roundId, call.id])).digest('hex')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    }
    return { context, attemptId: id(attemptMethod), outcomeId: id(outcomeMethod) }
  }
  const params = (input: Input) => ({ ...input, maxResults: input.maxResults ?? null })
  async function lockOwner(tx: Transaction<Database>, owner: string) {
    if (core.backend === 'postgres') await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agent-deep-research:' + owner}, 0))`.execute(tx)
  }
  const readOutcome = (input: Input, operation: ReturnType<typeof coordinate>) =>
    core.operationWithTransaction<Outcome>(operation.context, operation.outcomeId, outcomeMethod, params(input), async () => { throw absent })
  async function reconcile(input: Input, identity: RunIdentity & { roundId: string }, call: ToolCall): Promise<ToolResult> {
    if (!options.matches(identity)) return { kind: 'unknown' }
    try {
      return { ...(await readOutcome(input, coordinate(identity, identity.roundId, call))).result, mutated: false }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return searchRejected(error.message)
      return { kind: 'unknown' }
    }
  }
  return { reconcile, async search(input, scope, call) {
    const { identity, roundId, signal } = scope
    if (!options.matches(identity)) return searchRejected(`当前运行无权进行${label}`)
    const operation = coordinate(identity, roundId, call)
    try {
      const previous = await readOutcome(input, operation)
      return { ...previous.result, mutated: false }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return searchRejected(error.message)
      if (error !== absent) return { kind: 'unknown' }
    }
    signal.throwIfAborted()
    const prepared = await options.prepare(input, scope)
    if ('error' in prepared) return searchRejected(prepared.error)
    try {
      const receipt = await core.operationWithTransaction(operation.context, operation.attemptId, attemptMethod, params(input), async (tx, owner) => {
        await lockOwner(tx, owner)
        signal.throwIfAborted()
        const row = await tx.selectFrom('core_operation_receipts').select(eb => eb.fn.countAll().as('count'))
          .where('owner_id', '=', owner).where('method', 'in', countedAttempts)
          .where('created_at', '>=', databaseTime(prepared.reservationSince, core.backend))
          .where('result_json', '=', JSON.stringify(pending)).executeTakeFirstOrThrow()
        const denied = await prepared.reserve(tx, Number(row.count))
        if (denied) throw new Refused(denied)
        return pending
      }, { signal })
      if (receipt.replayed) return reconcile(input, { ...identity, roundId }, call)
      const value = signal.aborted ? { error: `${label}已取消` } : await prepared.request(signal)
      const success = !Object.hasOwn(value, 'error')
      const result: Outcome = { kind: 'completed', successful: success, mutated: success, value }
      // 远端已作答，仍需结算，即使此时原 Run 已取消。
      const outcome = await core.operationWithTransaction(operation.context, operation.outcomeId, outcomeMethod, params(input), async (tx, owner) => {
        await lockOwner(tx, owner)
        if (success) await options.recordUsage(tx, operation.context.ownerId, input)
        const updated = await tx.updateTable('core_operation_receipts').set({ result_json: JSON.stringify(settled) })
          .where('owner_id', '=', owner).where('operation_id', '=', operation.attemptId).where('method', '=', attemptMethod).executeTakeFirstOrThrow()
        if (updated.numUpdatedRows !== 1n) throw new Error('搜索认领不存在')
        return result
      })
      return outcome.result
    } catch (error) {
      if (error instanceof Refused || (error instanceof CoreError && error.code === 'conflict')) return searchRejected(error.message)
      return { kind: 'unknown' }
    }
  } }
}

const similarImageSchema = z.object({
  attach_id: z.string().optional(),
  image_url: z.string().optional(),
  max_results: z.number().int().min(1).max(20).optional(),
}).refine(args => args.attach_id !== undefined || args.image_url !== undefined)

type SimilarImageInput = { attachmentId: string; url: string; maxResults?: number }
export type SimilarImageSearchPort = PaidSearchPort<SimilarImageInput>

function normalizedImage(input: unknown): SimilarImageInput {
  const args = input as z.infer<typeof similarImageSchema>
  const attachmentId = args.attach_id?.trim() ?? ''
  return { attachmentId, url: attachmentId ? '' : args.image_url?.trim() ?? '', maxResults: args.max_results }
}

export function createSimilarImageSearchTool(port: SimilarImageSearchPort): ToolDefinition {
  return {
    definition: { name: 'similar_image_search', schema: { type: 'function', function: {
      name: 'similar_image_search',
      description: '用已有的 JPG 或 PNG 附件、图片 URL 查找相似候选。',
      parameters: { type: 'object', properties: {
        attach_id: { type: 'string' },
        image_url: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: 20 },
      }, anyOf: [{ required: ['attach_id'] }, { required: ['image_url'] }] },
    } } },
    effect: 'write',
    validate(input) { return similarImageSchema.safeParse(input) },
    ...(port.reconcile ? { reconcile: (input: unknown, identity: RunIdentity & { roundId: string }, call: ToolCall) =>
      port.reconcile!(normalizedImage(input), identity, call) } : {}),
    async execute(input, scope, call) {
      const normalized = normalizedImage(input)
      if (!normalized.attachmentId && !normalized.url)
        return searchRejected('需要提供当前图片、附件 ID 或网络图片地址')
      scope.signal.throwIfAborted()
      return port.search(normalized, scope, call)
    },
  }
}
