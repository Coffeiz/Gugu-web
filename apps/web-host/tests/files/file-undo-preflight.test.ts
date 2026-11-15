import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { preflightFileUndo, readFileUndoArtifact } from '../../src/domains/undo/persistence/files.js'

test('批量文件撤销先检查全部 owner 和版本，冲突时不执行写入', async () => {
  const calls: string[] = []
  const client = { async query(sql: string, params: unknown[]) {
    calls.push(sql)
    return { rows: params[0] === 1 && params[1] === 'owner' ? [{ version: 2 }] : [] }
  } } as unknown as PoolClient
  await assert.rejects(preflightFileUndo(client, 'owner', {
    action: 'delete', before_state: {}, after_state: { items: { 'file:1': { version: 2 }, 'folder:2': { version: 1 } } },
  }, 'undo'))
  assert.equal(calls.length, 2)
  assert.ok(calls.every(sql => sql.startsWith('SELECT')))
})

test('正文 artifact 按撤销方向读取，拒绝跨用户及缺失内容', async () => {
  const owner = '00000000-0000-0000-0000-000000000001'
  const base = `${owner}/.undo/op-${'a'.repeat(32)}/file-1`
  const refs = { 'file:1': { before_key: `${base}/before`, after_key: `${base}/after` } }
  const seen: string[] = []
  const bytes = await readFileUndoArtifact(owner, 'file:1', refs, 'redo', async key => { seen.push(key); return new Uint8Array([7]) })
  assert.deepEqual(bytes, new Uint8Array([7]))
  assert.deepEqual(seen, [`${base}/after`])
  await assert.rejects(readFileUndoArtifact('other', 'file:1', refs, 'undo', async () => new Uint8Array()))
  await assert.rejects(readFileUndoArtifact(owner, 'file:1', refs, 'undo', async () => null))
  assert.equal(await readFileUndoArtifact(owner, 'file:2', refs, 'undo', async () => null), null)
})

test('重做检查撤销时记录的版本并拒绝其他用户资源', async () => {
  const client = { async query(_sql: string, params: unknown[]) { return { rows: params[1] === 'owner' ? [{ version: 4 }] : [] } } } as unknown as PoolClient
  const operation = { action: 'create', before_state: {}, after_state: { items: { 'file:1': { version: 1 } }, undo_versions: { 'file:1': 4 } } }
  assert.equal((await preflightFileUndo(client, 'owner', operation, 'redo')).size, 1)
  await assert.rejects(preflightFileUndo(client, 'other', operation, 'redo'))
})
