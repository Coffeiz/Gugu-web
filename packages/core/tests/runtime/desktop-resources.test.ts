import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { dataContext } from '../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import type { Database } from '../../src/data/schema.js'
import { createDesktopMcpCrypto } from '../../src/mcp/desktop-crypto.js'
import { desktopMcp } from '../../src/runtime/desktop-resources.js'

it('桌面 MCP 写入本地数据库，配置密文和重放收据互不泄露', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-resource-test-'))
  const database = join(directory, 'local.db')
  try {
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    const crypto = createDesktopMcpCrypto(database)
    try {
      const context = dataContext(ownerId)
      const mcp = desktopMcp(runtime.db, ownerId, crypto)
      const config = {
        name: '阅读目录', endpoint: 'https://example.com/mcp',
        credential_slots: [{ id: 'token', label: '令牌', target: 'header', name: 'Authorization', prefix: 'Bearer ' }],
        credential_values: { token: 'synthetic-test-value' },
      }
      const operationId = randomUUID()
      const save = () => runtime.operationWithTransaction(context, operationId, 'mcp.create', { fields: config },
        tx => desktopMcp<Database>(tx, ownerId, crypto).write(undefined, config))
      const { result: { id } } = await save()
      await expect(save()).resolves.toMatchObject({ result: { id }, replayed: true })
      await expect(mcp.list()).resolves.toMatchObject({ items: [{ id, endpoint: '', has_credentials: true }] })
      await expect(desktopMcp(runtime.db, ownerId, createDesktopMcpCrypto(database)).config(id))
        .resolves.toMatchObject({ endpoint: config.endpoint, credential_values: config.credential_values })
      const { rows } = await sql`SELECT * FROM user_mcp_servers`.execute(runtime.db)
      expect(JSON.stringify(rows)).not.toContain(config.endpoint)
      expect(JSON.stringify(rows)).not.toContain(config.credential_values.token)
      const { rows: receipts } = await sql`SELECT result_json FROM core_operation_receipts`.execute(runtime.db)
      expect(JSON.stringify(receipts)).not.toContain(config.credential_values.token)
      await expect(mcp.write(id, { transport: 'stdio' })).rejects.toMatchObject({ code: 'invalid_request' })
      await mcp.remove(id)
      await expect(mcp.config(id)).rejects.toMatchObject({ code: 'not_found' })
      for (let index = 0; index < 6; index++) {
        await mcp.write(undefined, { ...config, name: `阅读目录-${index}` })
      }
      const list = await mcp.list(0)
      expect(list.max_servers).toBeNull()
      expect(list.items).toHaveLength(6)
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
