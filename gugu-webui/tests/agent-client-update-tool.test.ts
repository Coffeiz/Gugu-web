import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentClientUpdateTool } from '../src/domains/agent-sessions/tools/agent-client-tool.js'
import type { ClientResponse } from '../src/app.js'
import type { SqlDataRuntime } from '@gugu/core/data'

const ownerA = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const ownerB = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

type StoredClient = ClientResponse & { userId: string }

function fakeCore(seed: StoredClient[]) {
  const rows = seed.map(row => ({ ...row }))
  const owners: string[] = []
  const updates: Array<{ ownerId: string; clientId: number; fields: Record<string, unknown> }> = []
  const runtime = {
    async transaction(context: { ownerId: string }, work: (data: unknown) => Promise<unknown>) {
      owners.push(context.ownerId)
      const owned = () => rows.filter(row => row.userId === context.ownerId)
      const data = {
        clients: {
          async list() { return owned() },
          repository: {
            async get(id: number) { return owned().find(row => row.id === id) ?? null },
          },
          async update(id: number, fields: Record<string, unknown>) {
            const row = owned().find(item => item.id === id)
            if (!row) throw new Error('联系人不存在')
            updates.push({ ownerId: context.ownerId, clientId: id, fields: { ...fields } })
            Object.assign(row, fields)
            return row
          },
        },
      }
      return work(data)
    },
  }
  return { runtime: runtime as unknown as SqlDataRuntime, rows, owners, updates }
}

function client(id: number, userId = ownerA, name = `联系人${id}`): StoredClient {
  return { id, userId, name, contact: '原联系人', email: 'old@example.test', phone: '555-0199', notes: '原备注' }
}

test('按 ID 更新仅写入显式字段，保留其它资料并使用当前 owner 的 Core 事务', async () => {
  const fake = fakeCore([client(1)])
  const updateClient = createAgentClientUpdateTool(fake.runtime)

  const result = await updateClient(ownerA, { client_id: 1, notes: '新备注' })

  assert.deepEqual(result, { success: true, client_id: 1, name: '联系人1' })
  assert.deepEqual(fake.owners, [ownerA])
  assert.deepEqual(fake.updates, [{ ownerId: ownerA, clientId: 1, fields: { notes: '新备注' } }])
  assert.deepEqual(fake.rows[0], { ...client(1), notes: '新备注' })
})

test('按姓名解析优先选唯一精确匹配，而不被部分匹配项误判为歧义', async () => {
  const fake = fakeCore([client(1, ownerA, '小北'), client(2, ownerA, '小北工作室')])
  const updateClient = createAgentClientUpdateTool(fake.runtime)

  const result = await updateClient(ownerA, { client: '小北', client_name: '北方联系人' })

  assert.deepEqual(result, { success: true, client_id: 1, name: '北方联系人' })
  assert.deepEqual(fake.updates, [{ ownerId: ownerA, clientId: 1, fields: { name: '北方联系人' } }])
})

test('姓名精确匹配不存在且多个部分匹配时返回候选并不写入', async () => {
  const fake = fakeCore([client(1, ownerA, '小北工作室'), client(2, ownerA, '北方公司')])
  const updateClient = createAgentClientUpdateTool(fake.runtime)

  const result = await updateClient(ownerA, { client: '北', notes: '不应写入' })

  assert.deepEqual(JSON.parse(result as string), {
    error: '有多个匹配「北」的联系人，请指明',
    candidates: [{ id: 1, name: '小北工作室' }, { id: 2, name: '北方公司' }],
  })
  assert.deepEqual(fake.updates, [])
})

test('跨 owner 的 ID 不解析为联系人，空 patch 在任何写入前被拒绝', async () => {
  const fake = fakeCore([client(9, ownerB, '别人的联系人'), client(10)])
  const updateClient = createAgentClientUpdateTool(fake.runtime)

  const crossOwner = await updateClient(ownerA, { client_id: 9, notes: '越权资料' })
  const emptyPatch = await updateClient(ownerA, { client_id: 10 })

  assert.deepEqual(JSON.parse(crossOwner as string), { error: '联系人不存在' })
  assert.match(JSON.parse(emptyPatch as string).error, /没提供要修改的字段/)
  assert.deepEqual(fake.updates, [])
})

test('姓名无匹配时返回错误，不尝试创建或更新其他联系人', async () => {
  const fake = fakeCore([client(1)])
  const updateClient = createAgentClientUpdateTool(fake.runtime)

  const result = await updateClient(ownerA, { client: '不存在的联系人', email: 'new@example.test' })

  assert.deepEqual(JSON.parse(result as string), { error: '未找到联系人「不存在的联系人」' })
  assert.deepEqual(fake.updates, [])
})
