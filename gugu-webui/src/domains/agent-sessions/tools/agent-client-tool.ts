import type { SqlDataRuntime } from '@gugu/core/data'
import { dataContext } from '@gugu/core'
import { createClientOperations } from '../../clients/persistence/clients.js'

export interface AgentCreateClientArgs extends Record<string, unknown> {
  client_name?: string
  contact?: string | null
  email?: string | null
  phone?: string | null
  notes?: string
}

export type AgentCreateClientResult =
  | { success: true; client_id: number; name: string }
  | { error: string }

/**
 * 将 Python Agent create_client 参数映射到现有 Core-backed 联系人 creator。
 * 不附加幂等、确认、撤销或事件副作用；owner 与事务由传入的 creator 负责。
 */
export function createAgentClientTool(core: SqlDataRuntime) {
  const clients = createClientOperations(core)
  return async function createAgentClient(
    authenticatedOwnerId: string,
    args: AgentCreateClientArgs,
  ): Promise<AgentCreateClientResult | string> {
    if (!args.client_name)
      return JSON.stringify({ error: '联系人名称必填' })

    const input = {
      name: args.client_name,
      contact: args.contact === undefined ? null : args.contact,
      email: args.email === undefined ? null : args.email,
      phone: args.phone === undefined ? null : args.phone,
      notes: args.notes === undefined ? '' : args.notes,
    }
    const client = await clients.create(authenticatedOwnerId, input)
    return { success: true, client_id: client.id, name: client.name }
  }
}

export interface AgentUpdateClientArgs extends Record<string, unknown> {
  client_id?: number
  client?: string
  client_name?: string
  contact?: string | null
  email?: string | null
  phone?: string | null
  notes?: string
}

const UPDATE_FIELDS = ['client_name', 'contact', 'email', 'phone', 'notes'] as const

function toolError(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ error: message, ...extra })
}

/** Agent 联系人单项更新；解析、校验和写入共用一次 owner-scoped Core 事务。 */
export function createAgentClientUpdateTool(core: SqlDataRuntime) {
  return async function updateAgentClient(
    authenticatedOwnerId: string,
    args: AgentUpdateClientArgs,
  ): Promise<{ success: true; client_id: number; name: string } | string> {
    return core.transaction(dataContext(authenticatedOwnerId), async data => {
      let client
      const clientId = args.client_id
      if (clientId) {
        client = await data.clients.repository.get(clientId)
        if (!client) return toolError('联系人不存在')
      } else if (args.client) {
        const name = String(args.client).trim()
        const rows = await data.clients.list()
        const exact = rows.filter(row => row.name === name)
        const matching = exact.length > 0
          ? exact
          : rows.filter(row => row.name.toLocaleLowerCase().includes(name.toLocaleLowerCase()))
        if (matching.length === 0)
          return toolError(`未找到联系人「${name}」`)
        if (matching.length > 1)
          return toolError(`有多个匹配「${name}」的联系人，请指明`, {
            candidates: matching.slice(0, 10).map(row => ({ id: row.id, name: row.name })),
          })
        client = matching[0]
      } else {
        return toolError('需提供 client_id 或联系人名 client')
      }

      if (!UPDATE_FIELDS.some(field => Object.hasOwn(args, field)))
        return toolError('没提供要修改的字段（client_name/contact/email/phone/notes），未改动。')

      const changes: Record<string, unknown> = {}
      for (const field of UPDATE_FIELDS) {
        if (!Object.hasOwn(args, field)) continue
        changes[field === 'client_name' ? 'name' : field] = args[field]
      }
      const updated = await data.clients.update(client.id, changes)
      return { success: true, client_id: updated.id, name: updated.name }
    })
  }
}
