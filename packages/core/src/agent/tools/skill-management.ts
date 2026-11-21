import { createHash } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { stableJson } from '../context/history/canonical-history.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import type { Database } from '../../data/schema.js'
import type { RunIdentity, ToolCall, ToolResult } from '../models.js'
import { removeUserSkillRow } from '../skills/user-delete.js'
import type { ClientDeleteConfirmationPort } from './clients.js'
import type { ConfirmationBinding } from './confirmation.js'
import { z } from 'zod'
import type { createSkillMetadataReader } from '../skills/user-read.js'
import { CoreError, dataContext } from '../../contracts/index.js'
import { UserSkillValidationError } from '../skills/user-validation.js'
import type { createUserSkillManager } from '../skills/user-management.js'
import type { ToolDefinition, ToolScope } from './contracts.js'

export type SkillMetadataListPort = ReturnType<typeof createSkillMetadataReader>
/** 管理目录与use_skill正文加载分离；停用项可列出，但不能据此获得执行权限。 */
export function createSkillManagementReadTools(list: SkillMetadataListPort): ToolDefinition[] {
  const schema=z.object({}).passthrough()
  return [{definition:{name:'list_skills',schema:{type:'function',function:{name:'list_skills',description:'列出内置及当前账号的用户技能元数据，包含停用项，不返回正文。',parameters:{type:'object',properties:{}}}}},
    effect:'read',validate:input=>schema.safeParse(input),
    async execute(_input,scope){
      const value=await list(scope.identity.ownerId,scope.signal)
      scope.signal.throwIfAborted()
      return {kind:'completed',successful:true,mutated:false,value}
    },
  }]
}

type SkillManager = ReturnType<typeof createUserSkillManager<Database>>
type SkillUpdateInput = {
  name?: string
  description_short?: string
  description_long?: string | null
  category?: string
  body?: string
  related_tools?: string[]
  enabled?: boolean
}

const createSchema = z.object({
  skill_name: z.string().min(1).max(120),
  description_short: z.string().min(1).max(100),
  description_long: z.string().max(500).optional(),
  category: z.enum(['personal', 'productivity', 'research', 'creative', 'other']).optional(),
  related_tools: z.array(z.string().max(80)).max(32),
  body: z.string().min(1).max(20000),
  managed_by: z.enum(['user', 'assistant']),
}).strict()

const updateSchema = z.object({
  id: z.string().trim().toUpperCase().regex(/^U[1-9][0-9]*$/u),
  skill_name: z.string().min(1).max(120).optional(),
  description_short: z.string().min(1).max(100).optional(),
  description_long: z.string().max(500).nullable().optional(),
  category: z.enum(['personal', 'productivity', 'research', 'creative', 'other']).optional(),
  related_tools: z.array(z.string().max(80)).max(32).optional(),
  body: z.string().min(1).max(20000).optional(),
  enabled: z.boolean().optional(),
}).strict()

function operationError(error: unknown): string | null {
  if (error instanceof UserSkillValidationError) return error.message
  if (error instanceof CoreError && error.code === 'not_found') return '技能不存在或不属于当前用户'
  return null
}

async function referencedRunTools(scope: ToolScope) {
  if (!scope.discoverRelatedTools) return []
  const tools = await scope.discoverRelatedTools()
  scope.signal.throwIfAborted()
  return tools.map(tool => tool.name).filter(name =>
    !['list_skills', 'create_skill', 'update_skill', 'delete_skill'].includes(name))
}

/** 与Python BaseSkill 的 create_skill/update_skill 对齐；安全权限由可信注册器负责。 */
export function createSkillManagementWriteTools(runtime: SqlDataRuntime,
  manager: Pick<SkillManager, 'prepareCreate' | 'prepareUpdate' | 'published'>,
  authorize: (tx: Transaction<Database>, identity: RunIdentity, signal: AbortSignal) => Promise<boolean>,
): ToolDefinition[] {
  if (!runtime.receipts) throw new Error('技能写入需要持久操作收据')
  const absent = new Error('技能写入收据不存在')
  const denied = new Error('当前运行无权写入技能')
  const fail = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })
  function binding(identity: RunIdentity, roundId: string, call: ToolCall) {
    const action = call.name === 'create_skill' ? 'create' : 'update'
    const method = `agent.skill.${action}`
    return { ...skillOperationKey(identity, roundId, call.id, method), method }
  }
  async function reconcile(input: unknown, identity: RunIdentity & { roundId: string }, call: ToolCall): Promise<ToolResult> {
    const key = binding(identity, identity.roundId, call)
    try {
      const receipt = await runtime.operationWithTransaction(key.context, key.operationId, key.method, input as Record<string, unknown>, async () => { throw absent })
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return fail(error.message)
      return { kind: 'unknown' }
    }
  }
  async function apply(input: Record<string, unknown>, scope: ToolScope, call: ToolCall,
    prepare: () => Promise<(tx: Transaction<Database>) => Promise<unknown>>,
  ): Promise<ToolResult> {
    const { identity, signal, roundId } = scope
    signal.throwIfAborted()
    const key = binding(identity, roundId, call)
    try {
      if (await runtime.receipt(key.context, key.operationId)) return reconcile(input, { ...identity, roundId }, call)
      const write = await prepare()
      const receipt = await runtime.operationWithTransaction(key.context, key.operationId, key.method, input, async tx => {
        if (!await authorize(tx, identity, signal)) throw denied
        signal.throwIfAborted()
        const result = await write(tx)
        if (!await authorize(tx, identity, signal)) throw denied
        return result
      }, { signal })
      if (!receipt.replayed) await manager.published(key.context.ownerId)
      return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
    } catch (error) {
      if (error === denied) return fail(denied.message)
      if (error instanceof CoreError && error.code === 'conflict') return fail(error.message)
      const message = operationError(error)
      if (message !== null) return fail(message)
      return reconcile(input, { ...identity, roundId }, call)
    }
  }
  return [
    {
      definition: { name: 'create_skill', schema: { type: 'function', function: {
        name: 'create_skill',
        description: '创建可复用的 Prompt Skill。不能注册工具或扩大权限；关联工具只作引用。',
        parameters: { type: 'object', properties: {
          skill_name: { type: 'string', minLength: 1, maxLength: 120 },
          description_short: { type: 'string', minLength: 1, maxLength: 100 },
          description_long: { type: 'string', maxLength: 500 },
          category: { type: 'string', enum: ['personal', 'productivity', 'research', 'creative', 'other'] },
          related_tools: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 80 } },
          body: { type: 'string', minLength: 1, maxLength: 20000 },
          managed_by: { type: 'string', enum: ['user', 'assistant'] },
        }, required: ['skill_name', 'description_short', 'body', 'related_tools', 'managed_by'], additionalProperties: false },
      } } },
      effect: 'write',
      validate: input => createSchema.safeParse(input),
      reconcile,
      async execute(input, scope, call) {
        const value = input as z.infer<typeof createSchema>
        return apply(value, scope, call, async () => {
          const runTools = value.related_tools.length ? await referencedRunTools(scope) : []
          const write = await manager.prepareCreate(scope.identity.ownerId, {
            name: value.skill_name, description_short: value.description_short,
            description_long: value.description_long ?? null, category: value.category ?? 'personal',
            body: value.body, related_tools: value.related_tools,
            managed_by: value.managed_by,
          }, runTools)
          return async tx => {
            const skill = await write(tx)
            return {
              success: true,
              skill: { id: skill.id, name: skill.name, description_short: skill.description_short,
                related_tools: skill.related_tools, enabled: skill.enabled, managed_by: skill.managed_by },
              message: '已创建这个咕咕技能，后续会在需要时按需加载。',
            }
          }
        })
      },
    },
    {
      definition: { name: 'update_skill', schema: { type: 'function', function: {
        name: 'update_skill',
        description: '按稳定 Skill ID 更新当前用户的 Prompt Skill。至少提供一个要修改的字段。',
        parameters: { type: 'object', properties: {
          id: { type: 'string', pattern: '^U[1-9][0-9]*$' },
          skill_name: { type: 'string', minLength: 1, maxLength: 120 },
          description_short: { type: 'string', minLength: 1, maxLength: 100 },
          description_long: { type: ['string', 'null'], maxLength: 500 },
          category: { type: 'string', enum: ['personal', 'productivity', 'research', 'creative', 'other'] },
          related_tools: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 80 } },
          body: { type: 'string', minLength: 1, maxLength: 20000 },
          enabled: { type: 'boolean' },
        }, required: ['id'], additionalProperties: false },
      } } },
      effect: 'write',
      validate: input => updateSchema.safeParse(input),
      reconcile,
      async execute(input, scope, call) {
        const { id, skill_name, ...fields } = input as z.infer<typeof updateSchema>
        if (Object.keys(fields).length === 0 && skill_name === undefined)
          return { kind: 'completed', successful: false, mutated: false, value: { error: '至少提供一个要更新的字段' } }
        const patch: SkillUpdateInput = { ...fields, ...(skill_name === undefined ? {} : { name: skill_name }) }
        return apply(input as z.infer<typeof updateSchema>, scope, call, async () => {
          const runTools = await referencedRunTools(scope)
          const write = await manager.prepareUpdate(scope.identity.ownerId, id, patch, runTools)
          return async tx => {
            const skill = await write(tx)
            return {
              success: true,
              skill: { id: skill.id, name: skill.name, description_short: skill.description_short,
                related_tools: skill.related_tools, enabled: skill.enabled,
                content_digest: skill.content_digest, managed_by: skill.managed_by || 'user' },
              message: '已更新这个咕咕技能。',
            }
          }
        })
      },
    },
  ]
}

type SkillDeleteRow = {
  id: number; skill_id: string; name: string; description_short: string; description_long: string | null
  category: string; body: string; related_tools: unknown; managed_by: string; enabled: boolean
  content_digest: string; updated_at: string
}

async function readSkillDeleteTarget(db: Kysely<Database>, owner: string, id: string, lock = false) {
  const row = (await sql<SkillDeleteRow>`SELECT id,skill_id,name,description_short,description_long,category,
    body,related_tools,managed_by,enabled,content_digest,CAST(updated_at AS TEXT) AS updated_at
    FROM user_skills WHERE owner_id=${owner} AND skill_id=${id} AND source='user'
    ${lock ? sql`FOR UPDATE` : sql``}`.execute(db)).rows[0]
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1) return null
  return {
    name: row.name,
    managedByAssistant: row.managed_by === 'assistant',
    targetsDigest: skillDeleteDigest({ ids: [row.id] }),
    versionsDigest: skillDeleteDigest(row),
    targetIds: { skill_row_id: [row.id] },
  }
}

const skillDeleteInput = z.object({ id: z.string().trim().toUpperCase().regex(/^U[1-9][0-9]*$/u) }).strict()

export async function describeSkillDeleteTarget(db: Kysely<Database>, owner: string, input: unknown,
  expected: { targetsDigest: string; versionsDigest: string }) {
  const parsed = skillDeleteInput.safeParse(input)
  if (!parsed.success) throw new CoreError('invalid_request', '技能删除确认目标无效')
  const { id } = parsed.data
  const target = await readSkillDeleteTarget(db, owner, id)
  if (!target || target.targetsDigest !== expected.targetsDigest || target.versionsDigest !== expected.versionsDigest)
    throw new CoreError('conflict', '技能删除确认目标已变化')
  return `将删除技能「${target.name}」（${id}），此操作不可恢复`
}

function skillDeleteDigest(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function skillOperationKey(identity: RunIdentity, roundId: string, toolCallId: string, method: string) {
  const context = dataContext(identity.ownerId)
  const hex = skillDeleteDigest([method, context.ownerId, identity.sessionId, identity.runId, roundId, toolCallId])
  return { context, operationId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` }
}

/** 每次删除绑定当前 owner、Skill 及其内容版本；确认认领与删除收据同事务。 */
export function createSkillDeleteTool(
  runtime: SqlDataRuntime,
  confirmation: ClientDeleteConfirmationPort & {
    authorizeDirect?(tx: Transaction<Database>, binding: ConfirmationBinding, signal: AbortSignal): Promise<boolean>
  },
  publish: (ownerId: string) => Promise<unknown>,
): ToolDefinition {
  if (!runtime.receipts) throw new Error('删除技能需要持久操作收据')
  const schema = skillDeleteInput
  const missing = new Error('技能不存在或不属于当前用户')
  const changed = new Error('技能删除确认已使用或目标已变化')
  const rejected = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })
  const action = 'agent.skill.delete'
  async function reconcile(id: string, identity: RunIdentity, roundId: string, toolCallId: string): Promise<ToolResult> {
    const key = skillOperationKey(identity, roundId, toolCallId, action)
    try {
      const receipt = await runtime.operationWithTransaction(key.context, key.operationId, action, { id }, async () => { throw missing })
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return rejected('操作标识已用于不同内容')
      return { kind: 'unknown' }
    }
  }
  return {
    definition: { name: 'delete_skill', schema: { type: 'function', function: {
      name: 'delete_skill', description: '删除当前用户的自定义 Skill。按当前平台确认流程执行，删除后不可恢复。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    } } },
    effect: 'write', requiresInteraction: true, confirmationReplay: true,
    validate: input => schema.safeParse(input),
    reconcile(input, identity, call) {
      return reconcile((input as z.infer<typeof schema>).id, identity, identity.roundId, call.id)
    },
    async execute(input, scope, call) {
      const { id } = input as z.infer<typeof schema>
      scope.signal.throwIfAborted()
      const key = skillOperationKey(scope.identity, scope.roundId, call.id, action)
      if (scope.resolution?.status === 'confirmed') {
        const result = await reconcile(id, scope.identity, scope.roundId, call.id)
        if (result.kind !== 'unknown') return result
      }
      const owner = runtime.backend === 'sqlite' ? key.context.ownerId.replaceAll('-', '') : key.context.ownerId
      const target = await readSkillDeleteTarget(runtime.db, owner, id)
      scope.signal.throwIfAborted()
      if (!target) return rejected(missing.message)
      const digest = skillDeleteDigest({ id })
      if ((!target.managedByAssistant || !confirmation.authorizeDirect) && !scope.resolution) {
        const result = await confirmation.gate.prepare(call, scope, digest, target)
        return result.ok ? { kind: 'waiting', interaction: result.value } : rejected('技能删除确认无效或已过期')
      }
      const verified = scope.resolution ? await confirmation.gate.verify(call, scope, digest, target) : null
      if (verified && !verified.ok) return rejected('技能删除确认无效或已过期')
      try {
        const receipt = await runtime.operationWithTransaction(key.context, key.operationId, action, { id }, async tx => {
          scope.signal.throwIfAborted()
          const allowed = verified?.ok
            ? await confirmation.claim(tx, verified.value, scope.signal)
            : await confirmation.authorizeDirect?.(tx, {
              ...scope.identity, roundId: scope.roundId, toolCallId: call.id, toolName: call.name, normalizedInputDigest: digest,
            }, scope.signal) === true
          if (!allowed) throw changed
          const current = await readSkillDeleteTarget(tx, owner, id, runtime.backend === 'postgres')
          scope.signal.throwIfAborted()
          if (current?.targetsDigest !== target.targetsDigest || current.versionsDigest !== target.versionsDigest) throw changed
          if (!await removeUserSkillRow<Database>(tx, owner, id)) throw changed
          scope.signal.throwIfAborted()
          return { success: true, id, message: '已删除这个咕咕技能。' }
        }, { signal: scope.signal })
        if (!receipt.replayed) {
          try { await publish(key.context.ownerId) } catch { /* 提交后的通知失败不回滚。 */ }
        }
        return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
      } catch (error) {
        if (error === changed) return rejected(changed.message)
        if (scope.signal.aborted) throw error
        return reconcile(id, scope.identity, scope.roundId, call.id)
      }
    },
  }
}
