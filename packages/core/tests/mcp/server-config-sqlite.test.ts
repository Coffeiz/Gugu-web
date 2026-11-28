import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { CoreError } from '../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { createMcpServerCreator } from '../../src/mcp/server-create.js'
import { createMcpServerConfigLister } from '../../src/mcp/server-list.js'
import { createMcpServerMutations } from '../../src/mcp/server-mutations.js'

test('Core MCP 配置 CRUD 在 SQLite 保留 owner、凭据和快照事务语义', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-core-mcp-sqlite-'))
  const path = join(directory, 'core.db')
  await initializeSqlite(path)
  const opened = await openSqliteRuntime(path)
  const db = opened.runtime.db
  const owner = opened.ownerId
  const other = '00000000-0000-4000-8000-000000000102'
  const expectedSlot = { id: 'token', label: 'token', target: 'header', name: 'Authorization', prefix: 'Bearer ' }
  const sealed = (ciphertext: string) => ({ ciphertext: `sealed:${ciphertext}`, nonce: 'nonce', encryptedDataKey: 'key', keyVersion: 1 })
  const values = new Map<string, string>()
  const crypto = {
    async encrypt(value: string) { values.set(`sealed:${value}`, value); return sealed(value) },
    async decrypt(input: { ciphertext: string }) {
      const value = values.get(input.ciphertext)
      if (value === undefined) throw new Error('unknown ciphertext')
      return value
    },
  }
  const create = createMcpServerCreator(db, { maxServersPerUser: 4, id: () => '00000000-0000-4000-8000-000000000201', encrypt: crypto.encrypt }, 'sqlite')
  const list = createMcpServerConfigLister(db, 'sqlite')
  const mutations = createMcpServerMutations(db, { crypto, maxTools: 16 }, 'sqlite')

  try {
    await db.insertInto('user_mcp_tool_schema_snapshots').values({
      user_id: owner.replaceAll('-', ''), config_digest: 'stale', schemas: '[]', refreshed_at: new Date().toISOString(),
    }).execute()
    const created = await create(owner, {
      name: '个人服务', transport: 'http', endpoint: 'https://mcp.example.test/mcp', command: '',
      credential_slots: [{ id: 'token', target: 'header', name: 'Authorization', prefix: 'Bearer ' }],
      credential_values: { token: 'secret-value' }, enabled: true, confirm_mode: 'confirm_all',
      timeout_seconds: 30, tool_allowlist: ['lookup'],
    })
    assert.equal(created.endpoint, 'https://mcp.example.test/mcp')
    assert.deepEqual(created.credential_values, { token: 'secret-value' })
    const storedSnapshot = await db.selectFrom('user_mcp_tool_schema_snapshots').select('user_id').executeTakeFirst()
    assert.equal(storedSnapshot, undefined)
    assert.equal(await list(other).then(rows => rows.length), 0)
    const listed = await list(owner)
    assert.equal(listed.length, 1)
    assert.deepEqual(listed[0]?.credential_slots, [expectedSlot])
    assert.deepEqual(listed[0]?.tool_allowlist, ['lookup'])
    await assert.rejects(create(owner, {
      name: '个人服务', transport: 'http', endpoint: 'https://mcp.example.test/other', command: '',
      credential_slots: [], credential_values: {}, enabled: true, confirm_mode: 'confirm_all',
      timeout_seconds: 30, tool_allowlist: [],
    }), (error: unknown) => error instanceof CoreError && error.code === 'invalid_request')
    const updated = await mutations.update(owner, created.id, { enabled: false })
    assert.equal(updated.enabled, false)
    assert.deepEqual(updated.credential_values, { token: 'secret-value' })
    assert.deepEqual(updated.credential_slots, [expectedSlot])
    assert.deepEqual(updated.tool_allowlist, ['lookup'])
    await assert.rejects(mutations.update(other, created.id, { name: '越权' }),
      (error: unknown) => error instanceof CoreError && error.code === 'not_found')
    await mutations.remove(owner, created.id)
    await assert.rejects(mutations.remove(owner, created.id),
      (error: unknown) => error instanceof CoreError && error.code === 'not_found')
  } finally {
    await opened.runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
