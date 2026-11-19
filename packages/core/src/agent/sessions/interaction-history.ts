import { createHash, createHmac, randomBytes } from 'node:crypto'
import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../contracts/index.js'
import { databaseTime, utc } from '../../data/codec.js'

const processInteractionKey = randomBytes(32)

/** 同一动作在历史和实时投影中使用相同令牌，数据库仍只保存摘要。 */
export function deriveInteractionActionToken(ownerId: string, promptId: number, actionId: number, secretKey?: string) {
  return createHmac('sha256', secretKey || processInteractionKey)
    .update(JSON.stringify(['gugu-interaction-action-v1', dataContext(ownerId).ownerId, promptId, actionId]))
    .digest().subarray(0, 24).toString('base64url')
}

export interface AgentInteractionHistoryWindow {
  readonly restoreActive: boolean
  readonly startAtMs?: string
  readonly endBeforeMs?: string
  readonly toolCallIds?: readonly string[]
}
type Row = { id: number; session_id: number; kind: string; title: string; body: string; schema_json: unknown; status: string; active: boolean | number; expires_at: Date | string; created_at: Date | string }
type Action = { id: number; prompt_id: number; option_id: string; status: string; expires_at: Date | string; usable: boolean | number }
class JsonInteger { constructor(readonly raw: string) {} }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function truthy(value: unknown): boolean {
  if (value == null || value === false || value === 0 || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}
function pythonString(value: unknown): string {
  if (value instanceof JsonInteger) return value.raw
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (value == null) return 'None'
  return String(value)
}
function parseJson(text: string): unknown {
  const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown) => unknown
  return parse(text, (key, value, context) => {
    if (typeof value !== 'number') return value
    const raw = context.source ?? ''
    if ((key === 'tool_call_id' || key === 'id') && /[.eE]/.test(raw)) throw new CoreError('storage_error', '交互数字身份无法安全解析')
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if ((key === 'tool_call_id' || key === 'id') && /^-?\d+$/.test(raw)) return new JsonInteger(raw)
      throw new CoreError('storage_error', '交互数字无法安全解析')
    }
    return value
  })
}
function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return parseJson(value) } catch (error) { if (error instanceof CoreError) throw error; throw new CoreError('storage_error', '交互数据格式无效') }
}
function legacySchema(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return object(parseJson(value)) } catch (error) { if (error instanceof CoreError) throw error; return {} } }
  return object(value)
}
/** 毫秒边界向正无穷舍入至微秒，保持 >= 与 < 的窗口语义。 */
function boundary(value: string, backend: 'postgres' | 'sqlite'): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match) throw new TypeError('交互时间窗口无效')
  const fraction = (match[3] ?? '').padEnd(3, '0'), whole = BigInt(match[2]!) * 1000n + BigInt(fraction.slice(0, 3))
  const remainder = /[1-9]/.test(fraction.slice(3)), micros = match[1] ? -whole : whole + (remainder ? 1n : 0n)
  let ms = micros / 1000n, tail = micros % 1000n
  if (tail < 0) { ms -= 1n; tail += 1000n }
  const numeric = Number(ms)
  if (!Number.isSafeInteger(numeric)) throw new TypeError('交互时间窗口无效')
  const date = new Date(numeric)
  if (!Number.isFinite(date.getTime())) throw new TypeError('交互时间窗口无效')
  return databaseTime(date.toISOString().replace('Z', `${String(tail).padStart(3, '0')}Z`), backend)
}
function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(utc(value)).toISOString()
}
function sqliteTime(value: Date | string): string {
  if (typeof value !== 'string') throw new CoreError('storage_error', '交互时间格式无效')
  try { return databaseTime(utc(value), 'sqlite') }
  catch { throw new CoreError('storage_error', '交互时间格式无效') }
}
function label(schema: Record<string, unknown>, id: string): string {
  const options = Array.isArray(schema.options) ? schema.options : []
  const found = options.find(item => { const value = object(item).id; return (truthy(value) ? pythonString(value) : '') === id })
  if (!found) return id
  const value = object(found).label
  return truthy(value) ? pythonString(value) : ''
}
class PromptLockBusy extends Error {}

/** Kysely 事务提交后才返回可用 token；不管理 Host 的事件通知。 */
export function createSqlAgentInteractionHistory(db: Kysely<any>, backend: 'postgres' | 'sqlite', clock: () => Date = () => new Date(), secretKey?: string) {
  return async (ownerId: string, sessionId: number, window: AgentInteractionHistoryWindow) => {
    const canonical = dataContext(ownerId).ownerId
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new TypeError('会话身份无效')
    if (window.toolCallIds?.length === 0) return []
    const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const start = window.startAtMs === undefined ? null : boundary(window.startAtMs, backend)
    const end = window.endBeforeMs === undefined ? null : boundary(window.endBeforeMs, backend)
    const attempt = () => db.transaction().execute(async tx => {
      // SQLite 即使使用普通 deferred dialect，也必须在任何读取前取得写锁。
      if (backend === 'sqlite') await sql`UPDATE interaction_prompts SET id=id WHERE 0`.execute(tx)
      // 候选上界不依赖时钟：窗口内的记录可能在等锁时过期；活动状态也可能需要恢复。
      const candidateStart = start === null ? sql`` : sql` AND p.created_at>=${start}`
      const candidateEnd = end === null ? sql`` : sql` AND p.created_at<${end}`
      const candidateTool = window.toolCallIds === undefined ? sql`` : sql` AND p.schema_json #>> '{context,tool_call_id}' IN (${sql.join(window.toolCallIds)})`
      const candidateCondition = backend === 'sqlite' ? sql`1=1` : window.restoreActive
        ? sql`((1=1${candidateStart}${candidateEnd}${candidateTool}) OR p.status='active')`
        : sql`(1=1${candidateStart}${candidateEnd}${candidateTool})`
      const candidates = await sql<{ id: number }>`SELECT p.id FROM interaction_prompts p WHERE p.user_id=${owner} AND p.session_id=${sessionId} AND ${candidateCondition} ORDER BY p.id`.execute(tx)
      if (!candidates.rows.length) return []
      const ids = candidates.rows.map(row => row.id)
      const actionLock = backend === 'postgres' ? sql` FOR UPDATE` : sql``
      // Python 旧消费先锁 action；Node 消费先锁 prompt。不得持有 prompt 后等待 action。
      const actionRows = await sql<Omit<Action, 'usable'>>`SELECT id,prompt_id,option_id,status,expires_at FROM interaction_actions
        WHERE prompt_id IN (${sql.join(ids)}) ORDER BY id${actionLock}`.execute(tx)
      const promptLock = backend === 'postgres' ? sql` FOR UPDATE NOWAIT` : sql``
      try {
        await sql`SELECT p.id FROM interaction_prompts p WHERE p.user_id=${owner} AND p.session_id=${sessionId} AND p.id IN (${sql.join(ids)}) ORDER BY p.id${promptLock}`.execute(tx)
      } catch (error) {
        if (backend === 'postgres' && (error as { code?: string }).code === '55P03') throw new PromptLockBusy()
        throw error
      }
      const now = databaseTime(clock().toISOString(), backend)
      const active = sql`(p.status='active' AND p.expires_at>${now})`
      const startFilter = start === null ? sql`` : sql` AND p.created_at>=${start}`
      const endFilter = end === null ? sql`` : sql` AND p.created_at<${end}`
      const toolFilter = window.toolCallIds === undefined ? sql`` : sql` AND p.schema_json #>> '{context,tool_call_id}' IN (${sql.join(window.toolCallIds)})`
      const condition = backend === 'sqlite' ? sql`1=1` : window.restoreActive ? sql`(NOT ${active}${startFilter}${endFilter}${toolFilter} OR ${active})` : sql`(NOT ${active}${startFilter}${endFilter}${toolFilter})`
      const schemaColumn = backend === 'postgres' ? sql`p.schema_json::text` : sql`p.schema_json`
      const result = await sql<Row>`SELECT p.id,p.session_id,p.kind,p.title,p.body,p.status,${schemaColumn} AS schema_json,${active} AS active,p.expires_at,p.created_at
        FROM interaction_prompts p WHERE p.user_id=${owner} AND p.session_id=${sessionId} AND p.id IN (${sql.join(ids)}) AND ${condition} ORDER BY p.created_at,p.id`.execute(tx)
      const sorted = backend === 'sqlite' ? result.rows.map(row => {
        const expires = sqliteTime(row.expires_at), normalizedCreated = sqliteTime(row.created_at)
        return { ...row, active: row.status === 'active' && expires > now, normalizedCreated }
      })
        .filter(row => row.active ? window.restoreActive : (start === null || row.normalizedCreated >= start) && (end === null || row.normalizedCreated < end))
        .sort((left, right) => left.normalizedCreated.localeCompare(right.normalizedCreated) || left.id - right.id) : result.rows
      const prompts = sorted.flatMap(row => {
        const raw = decoded(row.schema_json)
        // Python 的历史 tool-call SQL 匹配在旧字符串二次解码之前执行。
        if (backend === 'sqlite' && !row.active && window.toolCallIds !== undefined) {
          const id = object(object(raw).context).tool_call_id
          if (typeof id !== 'string' || !window.toolCallIds.includes(id)) return []
        }
        return [{ row, schema: legacySchema(raw) }]
      })
      if (!prompts.length) return []
      const output = []
      for (const { row, schema } of prompts) {
        const context = object(schema.context), target = object(context.secret_target), secret = truthy(schema.secret_fields) && target.kind === 'mcp_credentials'
        const actions = secret ? [] : actionRows.rows.filter(item => item.prompt_id === row.id)
        const options: Array<{ id: string; label: string; token: string }> = []
        let selected: string | null = null
        for (const action of actions) {
          if (action.status === 'consumed') { selected = action.option_id; continue }
          const usable = backend === 'sqlite' ? sqliteTime(action.expires_at) > now : true
          if (!row.active || action.status !== 'pending' || !usable) continue
          const token = deriveInteractionActionToken(canonical, row.id, action.id, secretKey), hash = createHash('sha256').update(token).digest('hex')
          const expiryGuard = backend === 'sqlite' ? sql`expires_at=${action.expires_at}` : sql`expires_at>${now}`
          const updated = await sql`UPDATE interaction_actions SET token_hash=${hash} WHERE id=${action.id} AND prompt_id=${row.id} AND status='pending' AND ${expiryGuard} RETURNING id`.execute(tx)
          if (updated.rows.length) options.push({ id: action.option_id, label: label(schema, action.option_id), token })
        }
        const call = truthy(context.tool_call_id) ? pythonString(context.tool_call_id) : null
        const fields = schema.secret_fields, secretFields = Array.isArray(fields) ? fields : typeof fields === 'string' ? Array.from(fields) : fields && typeof fields === 'object' ? Object.keys(fields) : []
        output.push({ id: row.id, session_id: row.session_id, kind: row.kind, title: row.title, body: row.body, tool_call_id: call,
          task_paused: row.kind === 'confirm' && !!call, options, secret_fields: secretFields,
          allow_text_input: schema.source === 'agent' && truthy(schema.allow_text_input), custom_input_active: truthy(schema.custom_input_active),
          resolved: !row.active, selected_option_id: selected, response_text: object(schema.resolved_result).text ?? null,
          expires_at: timestamp(row.expires_at), created_at: timestamp(row.created_at) })
      }
      return output
    })
    for (let retries = 0;; retries++) {
      try { return await attempt() }
      catch (error) {
        if (!(error instanceof PromptLockBusy)) throw error
        if (retries >= 4) throw new CoreError('conflict', '交互正在更新，请稍后重试')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
  }
}

/** 连接池由调用方持有和关闭。 */
export function createPostgresAgentInteractionHistory(pool: Pool, clock?: () => Date, secretKey?: string) {
  return createSqlAgentInteractionHistory(new Kysely<any>({ dialect: new PostgresDialect({ pool }) }), 'postgres', clock, secretKey)
}
