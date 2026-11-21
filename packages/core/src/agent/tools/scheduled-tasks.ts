import { createHash } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { z } from 'zod'
import { strip } from '../../shared/values.js'
import { ScheduleValidationError } from '../../scheduled-tasks/normalize-schedule.js'
import { revokeTaskFilesystemAccessInTransaction, type TaskFilesystemRevokeEffects } from '../../scheduled-tasks/task-filesystem-revoke.js'
import { ScheduledTaskReferenceError, type ScheduledTaskCreateInput, type ScheduledTaskPatch } from '../../scheduled-tasks/task-write.js'
import { createKyselyScheduledTaskReader, projectScheduledTaskForAgent, type ScheduledTaskCapabilities } from '../../scheduled-tasks/task-list.js'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import type { Database } from '../../data/schema.js'
import { deleteScheduledTaskInTransaction } from '../../scheduled-tasks/task-delete-data.js'
import { stableJson } from '../context/history/canonical-history.js'
import type { Json, RunIdentity, ToolCall, ToolResult } from '../models.js'
import type { ToolDefinition, ToolScope } from './contracts.js'
import type { ConfirmationClaimReference, ConfirmationTargetSnapshot, createConfirmationGate } from './confirmation.js'


/** 可信 Host 绑定共享只读查询及平台能力；身份来自当前运行，不由模型指定。 */
export interface ScheduledTaskListPort {
  list(identity: RunIdentity, signal: AbortSignal): Promise<readonly unknown[]>
}

export function createListScheduledTasksTool(port: ScheduledTaskListPort): ToolDefinition {
  return {
    definition: { name: 'list_scheduled_tasks', schema: { type: 'function', function: {
      name: 'list_scheduled_tasks', description: '列出全部独立定时任务，不包含日历活动提醒。',
      parameters: { type: 'object', properties: {} },
    } } },
    effect: 'read',
    validate(input) {
      return input !== null && typeof input === 'object' && !Array.isArray(input)
        ? { success: true, data: {} } : { success: false }
    },
    async execute(_input, scope) {
      scope.signal.throwIfAborted()
      const value = await port.list(scope.identity, scope.signal)
      scope.signal.throwIfAborted()
      return { kind: 'completed', value, successful: true, mutated: false }
    },
  }
}

const taskId = z.number().int().safe()
const deleteSchema = z.object({ task_id: taskId.optional(), task: z.string().optional(), task_ids: z.array(taskId).max(50).optional() })
  .refine(input => !input.task_ids || new Set(input.task_ids).size === input.task_ids.length)
type DeleteInput = z.infer<typeof deleteSchema>
type WriteCoordinates = { identity: RunIdentity; roundId: string; toolCallId: string }
type DeleteRequest = WriteCoordinates & { args: DeleteInput }

type ScheduledTaskConfirmation = {
  gate: ReturnType<typeof createConfirmationGate>
  claim(tx: Transaction<Database>, reference: ConfirmationClaimReference, signal: AbortSignal): Promise<boolean>
}

class DeleteStateChanged extends Error {}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function operationKey({ identity, roundId, toolCallId }: WriteCoordinates, operation = 'delete') {
  const context = dataContext(identity.ownerId)
  const hex = digest([`agent.scheduled_task.${operation}`, context.ownerId, identity.sessionId, identity.runId, roundId, toolCallId])
  return { context, operationId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` }
}

function taskQuery(db: Kysely<Database>, owner: string, postgres: boolean) {
  const updated = postgres
    ? sql<string>`to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')`
    : sql<string>`updated_at`
  return db.selectFrom('scheduled_tasks').select(['id', 'name']).select(updated.as('version'))
    .where('user_id', '=', owner).where('event_id', 'is', null)
}
type TaskTarget = { id: number; name: string; version: string }

async function resolveTaskTargets(db: Kysely<Database>, owner: string, args: DeleteInput, postgres: boolean) {
  const query = taskQuery(db, owner, postgres)
  if (args.task_ids) {
    if (!args.task_ids.length) return { error: 'task_ids 必须是 1-50 个任务 id' }
    const rows = await query.where('id', 'in', args.task_ids).orderBy('id').execute()
    const missing = args.task_ids.find(id => !rows.some(row => Number(row.id) === id))
    return missing === undefined ? { rows } : { error: `定时任务 ${missing} 不存在` }
  }
  if (args.task_id) {
    const task = await query.where('id', '=', args.task_id).executeTakeFirst()
    return task ? { rows: [task] } : { error: '定时任务不存在' }
  }
  if (!args.task) return { error: '需提供 task_id 或任务名 task' }
  const name = strip(args.task)
  const exact = await query.where('name', '=', name).orderBy('id').limit(10).execute()
  const rows = exact.length ? exact : await query.where(sql<boolean>`lower(name) LIKE lower(${'%' + name + '%'})`)
    .orderBy('id').limit(10).execute()
  if (!rows.length) {
    const available = await query.clearSelect().select('name').distinct().orderBy('name').limit(20).execute()
    return { error: `未找到名为「${name}」的定时任务`, available: available.map(row => row.name) }
  }
  if (rows.length > 1) return { error: `有多个匹配「${name}」的定时任务，请指明是哪个`,
    candidates: rows.map(row => ({ id: Number(row.id), name: row.name })) }
  return { rows }
}

function snapshot(rows: readonly TaskTarget[]) {
  const targetIds = { task_id: rows.map(row => Number(row.id)) }
  return { targetIds, targetsDigest: digest(targetIds),
    versionsDigest: digest(rows.map(row => [Number(row.id), row.name, row.version])) }
}

export async function describeScheduledTaskDeleteTargets(
  db: Kysely<Database>, owner: string, input: unknown,
  expected: Pick<ConfirmationTargetSnapshot, 'targetsDigest' | 'versionsDigest'>,
): Promise<string> {
  const args = deleteSchema.parse(input)
  const { rows } = await resolveTaskTargets(db, owner, args, false)
  if (!rows) throw new CoreError('conflict', '定时任务删除确认目标已变化')
  const checked = snapshot(rows)
  if (checked.targetsDigest !== expected.targetsDigest || checked.versionsDigest !== expected.versionsDigest)
    throw new CoreError('conflict', '定时任务删除确认目标已变化')
  return formatScheduledTaskDeleteSummary(rows)
}

export function formatScheduledTaskDeleteSummary(rows: readonly { name: string }[]): string {
  const names = rows.slice(0, 10).map(row => row.name).join('、')
  const more = rows.length > 10 ? `等 ${rows.length} 个` : ''
  const visible = names.length > 900 ? `${Array.from(names).slice(0, 450).join('')}…` : names
  return `将删除定时任务：${visible}${more}，共 ${rows.length} 个`
}

export function createScheduledTaskDeleteTool(core: SqlDataRuntime, confirmation: ScheduledTaskConfirmation,
  publish: (ownerId: string, taskId: number) => Promise<void>): ToolDefinition {
  if (!core.receipts) throw new Error('定时任务删除收据未装配')
  const method = 'agent.scheduled_task.delete'
  const absent = new Error('定时任务删除收据不存在')
  const fail = (value: string | { error: string }): ToolResult => ({
    kind: 'completed', successful: false, mutated: false, value: typeof value === 'string' ? { error: value } : value,
  })
  async function reconcile(request: DeleteRequest): Promise<ToolResult> {
    try {
      const { context, operationId } = operationKey(request)
      const receipt = await core.operationWithTransaction(context, operationId, method, request.args, async () => { throw absent })
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
    } catch { return { kind: 'unknown' } }
  }

  async function apply(request: DeleteRequest, scope: ToolScope, call: ToolCall): Promise<ToolResult> {
    const { signal } = scope
    signal.throwIfAborted()
    const { context, operationId } = operationKey(request)
    const postgres = core.backend === 'postgres'
    const owner = postgres ? context.ownerId : context.ownerId.replaceAll('-', '')
    if (scope.resolution?.status === 'confirmed') {
      const previous = await reconcile(request)
      if (previous.kind === 'completed') return previous
    }
    const found = await resolveTaskTargets(core.db, owner, request.args, postgres)
    signal.throwIfAborted()
    if (!found.rows) return fail(found)
    const expected = snapshot(found.rows)
    const argsDigest = digest(request.args)
    if (scope.resolution === null) {
      const prepared = await confirmation.gate.prepare(call, scope, argsDigest, expected)
      return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : fail('定时任务删除确认无效或已过期')
    }
    const verified = await confirmation.gate.verify(call, scope, argsDigest, expected)
    if (!verified.ok) return fail('定时任务删除确认无效或已过期')
    try {
      const receipt = await core.operationWithTransaction(context, operationId, method, request.args, async tx => {
        signal.throwIfAborted()
        if (!await confirmation.claim(tx, verified.value, signal)) throw new DeleteStateChanged()
        let query = taskQuery(tx, owner, postgres).where('id', 'in', expected.targetIds.task_id).orderBy('id')
        if (postgres) query = query.forUpdate()
        const current = await query.execute()
        const actual = snapshot(current)
        if (expected.versionsDigest !== actual.versionsDigest || expected.targetsDigest !== actual.targetsDigest) throw new DeleteStateChanged()
        const results = []
        for (const task of current) {
          signal.throwIfAborted()
          const id = Number(task.id)
          if (!await deleteScheduledTaskInTransaction(tx, core.backend, owner, id, true)) throw new DeleteStateChanged()
          results.push({ deleted_task_id: id, name: task.name })
        }
        return request.args.task_ids
          ? { success: true, deleted_count: results.length, results }
          : { success: true, ...results[0]! }
      }, { signal })
      if (!receipt.replayed) for (const id of expected.targetIds.task_id) {
        try { await publish(context.ownerId, id) } catch { /* 提交后的通知故障不回滚删除。 */ }
      }
      return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
    } catch (error) {
      if (error instanceof DeleteStateChanged) return fail('定时任务删除确认已使用或目标已变化')
      if (error instanceof CoreError && error.code === 'conflict') return fail('操作标识已用于不同内容')
      return reconcile(request)
    }
  }

  const name = 'delete_scheduled_task'
  return {
    definition: { name, schema: { type: 'function', function: { name,
      description: '确认后删除一个或多个独立定时任务。单项传 task_id 或任务名 task，批量传 task_ids。',
      parameters: { type: 'object', properties: {
        task_id: { type: 'integer' }, task: { type: 'string' },
        task_ids: { type: 'array', items: { type: 'integer' }, maxItems: 50, uniqueItems: true },
      } } as Record<string, Json>,
    } } },
    effect: 'write', requiresInteraction: true, confirmationReplay: true,
    validate: input => deleteSchema.safeParse(input),
    execute: (args, scope, call) => apply({ args: args as DeleteInput, identity: scope.identity, roundId: scope.roundId, toolCallId: call.id }, scope, call),
    reconcile: (args, identity, call) => reconcile({ args: args as DeleteInput, identity, roundId: identity.roundId, toolCallId: call.id }),
  }
}

const scheduleKind = z.enum(['cron', 'interval', 'once'])
const deliveryMode = z.enum(['owner_private', 'current_group'])
function unique<T>(values: readonly T[]) { return new Set(values).size === values.length }
const taskInput = {
  schedule_name: z.string(),
  execution_mode: z.enum(['reminder', 'instruction']).describe('reminder 到点原样发送，不调用模型；instruction 到点由咕咕执行').optional(),
  instruction: z.string().describe('提醒模式填写要原样发送的正文，指令模式填写要执行的任务指令'), schedule_kind: scheduleKind,
  cron: z.string().nullable().optional(),
  interval_minutes: z.number().int().min(1).max(60).nullable().optional(),
  start_at: z.string().nullable().optional(), end_at: z.string().nullable().optional(),
  channels: z.array(z.enum(['web', 'email', 'feishu', 'qq'])).min(1).refine(unique).optional(),
  enabled: z.boolean().optional(), delivery_mode: deliveryMode.optional(),
  authorized_tools: z.array(z.literal('send_email')).max(1).optional(),
  email_attachment_file_ids: z.array(taskId.positive()).max(5).refine(unique).optional(),
  workspace_id: taskId.nullable().optional(), filesystem_authorized: z.boolean().optional(),
}
const createTaskSchema = z.object(taskInput).strict()
const updateTaskSchema = z.object({
  ...taskInput, schedule_name: taskInput.schedule_name.optional(), instruction: taskInput.instruction.optional(),
  schedule_kind: scheduleKind.nullable().optional(), task_id: taskId.optional(), task: z.string().optional(),
  task_ids: z.array(taskId.positive()).min(1).max(50).refine(unique).optional(),
}).strict().refine(args => [args.task_id, args.task, args.task_ids].filter(value => value !== undefined).length === 1
  && (!args.task_ids || typeof args.filesystem_authorized === 'boolean' && Object.keys(args).length === 2))
const taskWriteSchemas = { create_scheduled_task: createTaskSchema, update_scheduled_task: updateTaskSchema }
type TaskWriteName = keyof typeof taskWriteSchemas
type TaskInput = z.infer<typeof createTaskSchema> | z.infer<typeof updateTaskSchema>
type TaskWriteRequest = WriteCoordinates & ({ name: 'create_scheduled_task'; args: z.infer<typeof createTaskSchema> }
  | { name: 'update_scheduled_task'; args: z.infer<typeof updateTaskSchema> })

/** 只有具备真实调度消费和投递能力的 Host 才能装配此端口。 */
export interface ScheduledTaskWriteRuntime {
  capabilities: ScheduledTaskCapabilities
  reminderOnly?: boolean
  filesystemRevocation?: TaskFilesystemRevokeEffects
  emailAuthorization?: Partial<Record<TaskWriteName, ScheduledTaskConfirmation>>
  canPreauthorizeEmail?(identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  /** 事务内校验当前运行是否仍具有写入和目标投递权限，失败必须拒绝。 */
  authorize(tx: Transaction<Database>, identity: RunIdentity, input: TaskInput, signal: AbortSignal): Promise<boolean>
  /** 解析可信投递位置，接入已验证的实际平台目标，不能从模型接收收件身份。 */
  delivery(tx: Transaction<Database>, identity: RunIdentity,
    intent: { channels?: readonly string[]; mode?: z.infer<typeof deliveryMode>; taskId?: number },
    signal: AbortSignal): Promise<ScheduledTaskPatch>
  create(tx: Transaction<Database>, owner: string, input: ScheduledTaskCreateInput): Promise<number>
  update(tx: Transaction<Database>, owner: string, taskId: number, input: ScheduledTaskPatch): Promise<void>
  publish(owner: string, operation: 'create' | 'update', taskId: number): Promise<void>
}

class ScheduledTaskWriteRejected extends Error {
  constructor(readonly value: { error: string }) { super(value.error) }
}
function taskWriteFields(input: TaskInput): ScheduledTaskPatch {
  const fields: ScheduledTaskPatch = {}
  for (const key of ['schedule_kind', 'cron', 'interval_minutes', 'start_at', 'end_at', 'channels', 'enabled',
    'authorized_tools', 'email_attachment_file_ids', 'workspace_id', 'execution_mode'] as const) {
    if (input[key] !== undefined) Object.assign(fields, { [key]: input[key] })
  }
  if (input.schedule_name !== undefined) fields.name = strip(input.schedule_name)
  if (input.instruction !== undefined) fields.payload = input.execution_mode === 'reminder' ? input.instruction : strip(input.instruction)
  if (input.authorized_tools === undefined && input.delivery_mode !== undefined) fields.authorized_tools = []
  return fields
}

/** 普通独立任务的提交与调用收据同事务；更高权限必须另接可信授权交互。 */
export function createScheduledTaskWriteTools(core: SqlDataRuntime, runtime: ScheduledTaskWriteRuntime): ToolDefinition[] {
  if (!core.receipts) throw new Error('定时任务写入收据未装配')
  const absent = new Error('定时任务写入收据不存在')
  const fail = (value: { error: string; field?: string; message?: string }): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value })
  async function reconcile(request: TaskWriteRequest): Promise<ToolResult> {
    try {
      const { context, operationId } = operationKey(request, request.name)
      const receipt = await core.operationWithTransaction<{ id: number; value: unknown }>(
        context, operationId, request.name, request.args, async () => { throw absent },
      )
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result.value }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return fail({ error: '操作标识已用于不同内容' })
      return { kind: 'unknown' }
    }
  }
  async function apply(request: TaskWriteRequest, scope: ToolScope, call: ToolCall): Promise<ToolResult> {
    const { signal } = scope
    signal.throwIfAborted()
    const { args, identity } = request
    if (runtime.reminderOnly && args.execution_mode === 'instruction')
      return fail({ error: '此端仅支持提醒模式' })
    if (args.filesystem_authorized === true)
      return fail({ error: '本平台尚未提供定时任务沙箱的持久授权交互' })
    if (args.execution_mode === 'reminder' && (args.authorized_tools?.length || args.workspace_id != null))
      return fail({ error: '提醒模式只投递正文，不使用工具授权或工作区' })
    const grantsEmail = Boolean(args.authorized_tools?.length)
    const confirmation = grantsEmail ? runtime.emailAuthorization?.[request.name] : undefined
    if (grantsEmail && !confirmation) return fail({ error: '本平台尚未提供定时任务邮件工具的持久授权交互' })
    if (scope.resolution && !confirmation) return fail({ error: '该操作不接受确认回执' })
    const create = request.name === 'create_scheduled_task'
    const explicitRevocation = !create && args.filesystem_authorized === false
    const revocation = core.backend === 'postgres' ? runtime.filesystemRevocation : undefined
    if (explicitRevocation && !revocation) return fail({ error: '本平台尚未提供定时任务文件授权撤销能力' })
    const fields = taskWriteFields(args)
    if (create && !fields.name) return fail({ error: '需提供任务名 schedule_name' })
    if (!explicitRevocation && !Object.keys(fields).length) return fail({ error: '没提供要修改的字段（调度、名称、指令、渠道、启停、工作区或完整沙箱授权），未改动。' })
    if (args.schedule_kind === null) return fail({ error: 'schedule_kind 不能为空' })
    const { context, operationId } = operationKey(request, request.name)
    const owner = context.ownerId
    const postgres = core.backend === 'postgres'
    const ownerKey = postgres ? owner : owner.replaceAll('-', '')
    try {
      let confirmedTargets: ReturnType<typeof snapshot> | undefined
      let claim: ConfirmationClaimReference | undefined
      if (confirmation) {
        if (scope.resolution) {
          const previous = await reconcile(request)
          if (previous.kind !== 'unknown') return previous
        }
        if (!scope.resolution && !await runtime.canPreauthorizeEmail?.(identity, signal))
          return fail({ error: '当前账号的定时任务邮件工具不可用' })
        let currentTask: TaskTarget | undefined
        if (request.name === 'update_scheduled_task') {
          const found = await resolveTaskTargets(core.db, ownerKey, request.args, postgres)
          if (!found.rows) return fail(found)
          confirmedTargets = snapshot(found.rows)
          currentTask = found.rows[0]
        }
        signal.throwIfAborted()
        const name = String(fields.name ?? currentTask?.name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        const summary = `允许定时任务「${[...name].slice(0, 100).join('')}」运行时调用 send_email，无需逐次确认。`
        const inputDigest = digest(args)
        const target = {
          ...(confirmedTargets ?? { targetRefs: { scheduled_task_name: [digest(fields.name)] },
            targetsDigest: digest([owner, fields.name]), versionsDigest: inputDigest }),
          displaySummary: summary,
        }
        if (!scope.resolution) {
          const prepared = await confirmation.gate.prepare(call, scope, inputDigest, target)
          return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : fail({ error: '定时任务邮件授权确认已失效' })
        }
        const verified = await confirmation.gate.verify(call, scope, inputDigest, target)
        if (!verified.ok) return fail({ error: '定时任务邮件授权确认已失效' })
        claim = verified.value
      }

      const receipt = await core.operationWithTransaction(context, operationId, request.name, args, async tx => {
        signal.throwIfAborted()
        if (!await runtime.authorize(tx, identity, args, signal))
          throw new ScheduledTaskWriteRejected({ error: '定时任务写入或投递权限不可用' })
        if (confirmation && (!claim || !await confirmation.claim(tx, claim, signal)))
          throw new ScheduledTaskWriteRejected({ error: '定时任务邮件授权确认已失效' })
        let targets: number[] = []
        let reminder = args.execution_mode === 'reminder' || (create && runtime.reminderOnly === true)
        if (request.name === 'update_scheduled_task') {
          const found = await resolveTaskTargets(tx, ownerKey, request.args, postgres)
          if (!found.rows) throw new ScheduledTaskWriteRejected(found)
          targets = found.rows.map(row => Number(row.id))
          let current = taskQuery(tx, ownerKey, postgres).where('id', 'in', targets).orderBy('id')
          if (postgres) current = current.forUpdate()
          const currentRows = await current.select('execution_mode').execute()
          const locked = snapshot(currentRows)
          reminder = (args.execution_mode ?? currentRows[0]?.execution_mode) === 'reminder'
          const expected = confirmedTargets ?? snapshot(found.rows)
          if (locked.targetsDigest !== expected.targetsDigest || locked.versionsDigest !== expected.versionsDigest)
            throw new ScheduledTaskWriteRejected({ error: '定时任务刚被修改，请重试' })

          if (revocation && (explicitRevocation || args.enabled === false)) {
            let changedCount = 0
            for (const id of targets) {
              signal.throwIfAborted()
              if ((await revokeTaskFilesystemAccessInTransaction(tx, owner, id, revocation)).revoked) changedCount++
            }
            if (request.args.task_ids) {
              if (!await runtime.authorize(tx, identity, args, signal))
                throw new ScheduledTaskWriteRejected({ error: '提交前定时任务写入或投递权限已变化' })
              return { id: targets[0]!, ids: targets, value: {
                success: true, filesystem_authorized: false, task_ids: targets, changed_count: changedCount,
              } }
            }
          }
        }
        const target = targets[0]
        const delivery = create || args.channels !== undefined || args.delivery_mode !== undefined
          ? await runtime.delivery(tx, identity, {
            channels: args.channels ?? (create ? ['web'] : undefined), mode: args.delivery_mode, taskId: target,
          }, signal) : {}
        const write = { ...fields, ...delivery, ...(reminder && args.instruction !== undefined ? { payload: args.instruction } : {}) }
        signal.throwIfAborted()
        let id: number
        if (request.name === 'create_scheduled_task') {
          id = await runtime.create(tx, owner, { ...write, schedule_kind: request.args.schedule_kind, name: fields.name,
            ...(runtime.reminderOnly ? { execution_mode: 'reminder' } : {}) })
        } else {
          id = target!
          if (Object.keys(write).length) await runtime.update(tx, owner, id, write)
        }
        const reader = createKyselyScheduledTaskReader<Database>(tx, core.backend)
        const [row] = await reader(owner, null, signal, id)
        if (!row) throw new Error('定时任务写入后无法重新读取')
        if (!await runtime.authorize(tx, identity, args, signal))
          throw new ScheduledTaskWriteRejected({ error: '提交前定时任务写入或投递权限已变化' })
        return { id, value: { success: true, ...projectScheduledTaskForAgent(row, runtime.capabilities),
          ...(create ? { task_id: id, ...(row.enabled ? { note: '最多 30 秒后开始按时触发' } : {}) } : {}),
        } }
      }, { signal })
      if (!receipt.replayed) {
        for (const id of receipt.result.ids ?? [receipt.result.id]) {
          try { await runtime.publish(owner, create ? 'create' : 'update', id) } catch { /* 已提交。 */ }
        }
      }
      return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result.value }
    } catch (error) {
      if (error instanceof ScheduledTaskWriteRejected) return fail(error.value)
      if (error instanceof ScheduledTaskReferenceError) return fail({ error: error.message })
      if (error instanceof ScheduleValidationError) return fail({ error: '定时规则校验失败', field: error.field, message: error.message })
      if (error instanceof CoreError && error.code === 'conflict') return fail({ error: '操作标识已用于不同内容' })
      const result = await reconcile(request)
      if (result.kind === 'completed') return result
      signal.throwIfAborted()
      return result
    }
  }

  const descriptions = runtime.reminderOnly ? {
    create_scheduled_task: '创建独立提醒。提供 schedule_name、instruction 和 schedule_kind。到点通过本机通知原样投递正文，execution_mode 可省略或填写 reminder。',
    update_scheduled_task: '按 task_id 或 task 更新独立提醒。更新正文时填写 instruction，execution_mode 可省略或填写 reminder。',
  } : {
    create_scheduled_task: '创建独立定时任务，按可信渠道投递。提供 schedule_name、instruction 和 schedule_kind。提醒模式传 execution_mode=reminder，到点原样发送 instruction，不调用模型；指令模式传 instruction，到点由咕咕执行，可使用已授权工具。省略模式时按指令模式创建。',
    update_scheduled_task: '更新独立定时任务。通过 task_id 或 task 定位，execution_mode=reminder 到点原样投递正文，不调用模型；execution_mode=instruction 到点由咕咕执行指令。省略模式保持原值。批量撤销文件授权时传 task_ids 和 filesystem_authorized=false。',
  }
  return (Object.keys(taskWriteSchemas) as TaskWriteName[]).map(name => {
    const schema = taskWriteSchemas[name]
    return {
      definition: { name, schema: { type: 'function', function: {
        name, description: descriptions[name] + (runtime.emailAuthorization?.[name] ? '预授权 send_email 需要用户确认。' : ''), parameters: z.toJSONSchema(schema) as Record<string, Json>,
      } } },
      effect: 'write', strictArrayFields: ['channels', 'authorized_tools', 'email_attachment_file_ids', 'task_ids'],
      validate: input => schema.safeParse(input),
      ...(runtime.emailAuthorization?.[name] ? { requiresInteraction: true, confirmationReplay: true } : {}),
      execute: (args, scope, call) => apply({ args, name, identity: scope.identity, roundId: scope.roundId, toolCallId: call.id } as TaskWriteRequest, scope, call),
      reconcile: (args, identity, call) =>
        reconcile({ args, name, identity, roundId: identity.roundId, toolCallId: call.id } as TaskWriteRequest),
    }
  })
}
