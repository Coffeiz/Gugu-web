import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { preflightFileUndo, readFileUndoArtifact } from '../../../src/modules/undo/adapters/files.js'

test('批量文件撤销先检查全部 owner 和版本，且拒绝非路径资源引用', async () => {
  const calls: string[] = []
  const client = { async query(sql: string, params: unknown[]) {
    calls.push(sql)
    return { rows: params[0] === 1 && params[1] === 'owner' ? [{ version: 2 }] : [] }
  } } as unknown as PoolClient
  await assert.rejects(preflightFileUndo(client, 'owner', {
    action: 'delete', before_state: {}, after_state: { items: { 'file:1': { path: 'owner/personal/a.txt', version: 2 }, 'folder:2': { version: 1 } } },
  }, 'undo'))
  assert.equal(calls.length, 0)
  await assert.rejects(preflightFileUndo(client, 'owner', {
    action: 'delete', before_state: {}, after_state: { items: { 'file:owner/personal/a.txt': { path: 'owner/personal/a.txt', version: 3 } } },
  }, 'undo'))
  assert.equal(calls.length, 1)
  assert.ok(calls.every(sql => sql.startsWith('SELECT')))
})

test('正文 artifact 按撤销方向读取，拒绝跨用户及缺失内容', async () => {
  const owner = '00000000-0000-0000-0000-000000000001'
  const filePath = `${owner}/personal/内容.md`
  const fileHash = (await import('node:crypto')).createHash('sha256').update(filePath).digest('hex').slice(0, 24)
  const base = `${owner}/.undo/op-${'a'.repeat(32)}/file-${fileHash}`
  const ref = `file:${filePath}`
  const refs = { [ref]: { before_key: `${base}/before`, after_key: `${base}/after` } }
  const seen: string[] = []
  const bytes = await readFileUndoArtifact(owner, ref, refs, 'redo', async key => { seen.push(key); return new Uint8Array([7]) })
  assert.deepEqual(bytes, new Uint8Array([7]))
  assert.deepEqual(seen, [`${base}/after`])
  await assert.rejects(readFileUndoArtifact('other', ref, refs, 'undo', async () => new Uint8Array()))
  await assert.rejects(readFileUndoArtifact(owner, ref, refs, 'undo', async () => null))
  assert.equal(await readFileUndoArtifact(owner, `file:${owner}/personal/missing.txt`, refs, 'undo', async () => null), null)
})

test('重做检查撤销时记录的版本并拒绝其他用户资源', async () => {
  const path = 'owner/personal/new.txt'
  const client = { async query(_sql: string, params: unknown[]) { return { rows: params[1] === 'owner' && params[0] === path ? [{ version: 4 }] : [] } } } as unknown as PoolClient
  const ref = `file:${path}`
  const operation = { action: 'create', before_state: {}, after_state: { items: { [ref]: { path, version: 1 } }, undo_versions: { [ref]: 4 } } }
  assert.equal((await preflightFileUndo(client, 'owner', operation, 'redo')).size, 1)
  await assert.rejects(preflightFileUndo(client, 'other', operation, 'redo'))
})
