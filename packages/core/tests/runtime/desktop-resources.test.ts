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
import { desktopMcp, desktopSkills } from '../../src/runtime/desktop-resources.js'

it('桌面技能与 MCP 写入本地数据库，配置密文和重放收据互不泄露', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-resource-test-'))
  const database = join(directory, 'local.db')
  try {
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    const crypto = createDesktopMcpCrypto(database)
    try {
      const context = dataContext(ownerId)
      const skills = desktopSkills(runtime.db, ownerId)
      const fields = { name: '阅读笔记', description_short: '整理阅读记录', body: '按主题归类' }
      const first = await runtime.operationWithTransaction(context, randomUUID(), 'skills.create', { fields },
        tx => desktopSkills<Database>(tx, ownerId).write(undefined, fields))
      const skillId = first.result.id
      await runtime.db.transaction().execute(tx => desktopSkills<Database>(tx, ownerId).write(skillId, { enabled: false }))
      await expect(skills.list(0)).resolves.toMatchObject({ skills: [{ ...fields, id: skillId, enabled: false }] })
      await expect(desktopSkills(runtime.db, randomUUID()).list(0)).resolves.toMatchObject({ skills: [] })
      await skills.remove(skillId)
      await expect(skills.list(0)).resolves.toMatchObject({ skills: [] })

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
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
