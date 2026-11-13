import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentClientTool } from '../../src/domains/agent-sessions/tools/agent-client-tool.js'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { ClientResponse } from '../../src/app.js'

const ownerA = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const ownerB = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

function fakeCore() {
  const rows: Array<ClientResponse & { userId: string }> = []
  const calls: Array<{ ownerId: string; input: unknown }> = []
  const owners: string[] = []
  const runtime = {
    async transaction(context: { ownerId: string }, work: (data: unknown) => Promise<unknown>) {
      owners.push(context.ownerId)
      const data = {
        clients: {
          async create(input: { name: string; contact?: string | null; email?: string | null; phone?: string | null; notes: string }) {
            calls.push({ ownerId: context.ownerId, input })
            const row = {
              id: rows.length + 1,
              userId: context.ownerId,
              name: input.name,
              contact: input.contact ?? null,
              email: input.email ?? null,
              phone: input.phone ?? null,
              notes: input.notes,
            }
            rows.push(row)
            return row
          },
        },
      }
      return work(data)
    },
  }
  return { runtime: runtime as unknown as SqlDataRuntime, rows, calls, owners }
}

test('Agent 创建沿用 owner-scoped Core creator，映射字段并返回 Python 工具回执', async () => {
  const fake = fakeCore()
  const createClient = createAgentClientTool(fake.runtime)
  const result = await createClient(ownerA, {
    client_name: '小北', contact: '王女士', email: 'moon@example.test',
    phone: '555-0100', notes: '偏好邮件联系',
  })

  assert.deepEqual(fake.calls, [{
    ownerId: ownerA,
    input: {
      name: '小北', contact: '王女士', email: 'moon@example.test',
      phone: '555-0100', notes: '偏好邮件联系',
    },
  }])
  assert.deepEqual(result, { success: true, client_id: 1, name: '小北' })
})

test('联系人名称缺失时在写入前返回错误，不打开创建事务', async () => {
  const fake = fakeCore()
  const createClient = createAgentClientTool(fake.runtime)

  const result = await createClient(ownerA, { client_name: '' })

  assert.deepEqual(JSON.parse(result as string), { error: '联系人名称必填' })
  assert.deepEqual(fake.calls, [])
  assert.deepEqual(fake.rows, [])
})

test('联系人字段缺省时与 Python create_client 一样保存 null 和空备注', async () => {
  const fake = fakeCore()
  const createClient = createAgentClientTool(fake.runtime)

  const result = await createClient(ownerA, { client_name: '仅名称联系人' })

  assert.deepEqual(result, { success: true, client_id: 1, name: '仅名称联系人' })
  assert.deepEqual(fake.calls[0]?.input, {
    name: '仅名称联系人', contact: null, email: null, phone: null, notes: '',
  })
})

test('相同内容分别由不同 owner 创建时保持各自的数据归属', async () => {
  const fake = fakeCore()
  const createClient = createAgentClientTool(fake.runtime)
  const args = { client_name: '共享名称' }

  const first = await createClient(ownerA, args)
  const second = await createClient(ownerB, args)

  if (typeof first === 'string' || !('success' in first) || !first.success) assert.fail('第一个 owner 创建应成功')
  if (typeof second === 'string' || !('success' in second) || !second.success) assert.fail('第二个 owner 创建应成功')
  assert.deepEqual(fake.rows.map(({ userId }) => userId), [ownerA, ownerB])
  assert.deepEqual(fake.owners, [ownerA, ownerB])
  assert.notEqual(first.client_id, second.client_id)
  assert.deepEqual(fake.calls.map(call => call.ownerId), [ownerA, ownerB])
})

test('Python Agent 创建未提供幂等键，不会把两个成功调用合并成一次', async () => {
  const fake = fakeCore()
  const createClient = createAgentClientTool(fake.runtime)
  const args = { client_name: '重复调用联系人' }

  const first = await createClient(ownerA, args)
  const second = await createClient(ownerA, args)

  if (typeof first === 'string' || !('success' in first) || !first.success) assert.fail('第一次联系人创建应成功')
  if (typeof second === 'string' || !('success' in second) || !second.success) assert.fail('第二次联系人创建应成功')
  assert.notEqual(first.client_id, second.client_id)
  assert.equal(fake.rows.length, 2)
})
