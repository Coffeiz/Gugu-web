import { z } from 'zod'
import { strip } from '../../shared/values.js'
import { CoreError, dataContext } from '../../contracts/index.js'
import { ClientValidationError } from '../../clients/service.js'
import type { ClientRecord, Fields, Json } from '../../contracts/index.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import type { ToolResult } from '../models.js'
import type { ToolDefinition } from './contracts.js'
import { redactToolError } from '../core.js'
import { enrichToolError } from './input-errors.js'

const fields = { client_name: z.string().optional(), contact: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), notes: z.string().optional() }
const validators = {
  list_clients: z.object({}).passthrough(),
  create_client: z.object({ ...fields, client_name: z.string() }).passthrough(),
  update_client: z.object({ client_id: z.number().int().safe().optional(), client: z.string().optional(), client_ids: z.array(z.number().int().safe()).max(50).refine(ids => new Set(ids).size === ids.length).meta({ uniqueItems: true }).optional(), ...fields }).passthrough(),
}
const descriptions = { list_clients: '列出当前用户的所有联系人。', create_client: '新建联系人，记录联系人、邮箱、电话、备注。', update_client: '修改联系人信息（名称/联系人/邮箱/电话/备注）。' }
function completed(value: unknown, successful = true, mutated = false): ToolResult {
  return { kind: 'completed', value, successful, mutated }
}
function failed(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return completed(JSON.stringify({ error, ...extra }), false)
}
function projection(row: ClientRecord) {
  const { id, name, contact, email, phone, notes } = row
  return { id, name, contact, email, phone, notes }
}
/** 使用已有 owner-scoped Core 数据服务，不另建联系人数据库实现。 */
export function createClientTools(runtime: SqlDataRuntime): ToolDefinition[] {
  return (Object.keys(validators) as (keyof typeof validators)[]).map(name => ({
    definition: { name, schema: { type: 'function', function: { name, description: descriptions[name], parameters: z.toJSONSchema(validators[name]) as Record<string, Json> } } },
    effect: name === 'list_clients' ? 'read' : 'write',
    validate(input) { return validators[name].safeParse(input) },
    async execute(input, scope) {
      const args = input as Record<string, unknown>
      let callbackError: unknown
      // 提交失败等非领域异常交给注册器保留 unknown，不能伪装普通失败。
      try {
        return await runtime.transaction(dataContext(scope.identity.ownerId), async data => {
          try {
            if (name === 'list_clients') return completed((await data.clients.list()).map(projection))
            if (name === 'create_client') {
              if (!args.client_name) return failed('联系人名称必填')
              const row = await data.clients.create({ name: args.client_name, contact: args.contact ?? null, email: args.email ?? null, phone: args.phone ?? null, notes: args.notes ?? '' })
              return completed({ success: true, client_id: row.id, name: row.name }, true, true)
            }
            let row: ClientRecord | null | undefined
            if (args.client_id) {
              row = await data.clients.repository.get(args.client_id as number)
              if (!row) return failed('联系人不存在')
            } else if (args.client) {
              const query = strip(args.client as string)
              const candidates = await data.clients.findByName(query)
              if (!candidates.length) return failed(`未找到联系人「${query}」`)
              if (candidates.length > 1) return failed(`有多个匹配「${query}」的联系人，请指明`, { candidates: candidates.slice(0, 10).map(item => ({ id: item.id, name: item.name })) })
              row = candidates[0]
            } else return failed('需提供 client_id 或联系人名 client')
            const changes: Fields = {}
            for (const key of Object.keys(fields)) if (Object.hasOwn(args, key)) changes[key === 'client_name' ? 'name' : key] = args[key]
            if (!Object.keys(changes).length) return failed('没提供要修改的字段（client_name/contact/email/phone/notes），未改动。')
            const updated = await data.clients.update(row!.id, changes)
            return completed({ success: true, client_id: updated.id, name: updated.name }, true, true)
          } catch (error) { callbackError = error; throw error }
        }, { signal: scope.signal })
      } catch (error) {
        if (error === callbackError && error instanceof ClientValidationError) return {
          kind: 'completed', value: JSON.stringify({ error: '联系人字段无效' }), successful: false, mutated: false,
          modelValue: enrichToolError(name, { error: redactToolError(`工具 ${name} 执行出错：ValueError: ${error.message}`) }),
        }
        if (error === callbackError && error instanceof CoreError && error.code === 'invalid_request') return failed('联系人字段无效')
        throw error
      }
    },
  }))
}
