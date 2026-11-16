import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { dataContract } from '../../fixtures/data-contract.js'
import { expect, it } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { execute } from '../../../src/runtime/commands.js'
import type { ClientRecord, ProjectRecord } from '../../../src/contracts/index.js'

dataContract('临时 SQLite 的项目/联系人同逻辑回归', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gugu-contract-')),
    path = join(folder, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path, {
      clock: () => '2026-11-10T10:00:00.123456Z',
    })
    return {
      runtime,
      owner: ownerId,
      other: randomUUID(),
      close: async () => {
        await runtime.close()
        rmSync(folder, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        })
      },
    }
  } catch (error) {
    rmSync(folder, { recursive: true, force: true })
    throw error
  }
})

it('桌面项目改名和联系人维护命令经 Core 收据提交，正式 SQLite 重开后结果仍在', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gugu-project-client-reopen-')), path = join(folder, 'core.db')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const context = dataContext(opened.ownerId)
    const run = <T>(method: string, params: Record<string, unknown>, operationId = randomUUID()) =>
      runtime!.operation(context, operationId, method, params, data => execute(data, method, params) as Promise<T>)
    const project = await run<ProjectRecord>('projects.create', { name: '原项目' })
    const client = await run<ClientRecord>('clients.create', {
      name: '小北', contact: '联系人', email: 'test@example.invalid', phone: '10000', notes: '保留资料',
    })
    const renameId = randomUUID(), rename = { id: project.id, version: 1, name: '新项目' }
    const changed = await run<ProjectRecord>('projects.rename', rename, renameId)
    expect(await run('projects.rename', rename, renameId)).toEqual(changed)
    await expect(run('projects.rename', { ...rename, name: '陈旧修改' })).rejects.toMatchObject({ code: 'conflict' })
    const updated = await run<ClientRecord>('clients.update', { id: client.id, fields: { name: '小南', phone: null } })
    expect(updated).toMatchObject({ name: '小南', phone: null, email: client.email, notes: client.notes })
    const removed = await run<ClientRecord>('clients.create', { name: '待删除联系人' })
    await run('clients.delete', { id: removed.id })
    await runtime.close()
    const reopened = await openSqliteRuntime(path)
    runtime = reopened.runtime
    expect(reopened.ownerId).toBe(opened.ownerId)
    expect(await runtime.transaction(context, data => data.projects.get(project.id))).toEqual(changed)
    expect(changed).toMatchObject({ name: '新项目', version: 2 })
    expect(await runtime.transaction(context, data => data.clients.list())).toEqual([updated])
    expect(await runtime.receipt(context, renameId)).toEqual({ method: 'projects.rename', result: changed })
  } finally {
    await runtime?.close()
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
