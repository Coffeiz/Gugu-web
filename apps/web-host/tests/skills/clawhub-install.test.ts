import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { createWebClawHubInstaller } from '../../src/modules/skills/clawhub-install.js'

test('Web 安装完整技能包并登记撤销，已有目录不被覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-web-skill-install-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const target = join(root, owner, '.agent', 'skills', 'demo')
  const records: unknown[][] = []
  const client = { async query(sql: string, values?: unknown[]) {
    if (sql.includes('INSERT INTO undo_operations')) records.push(values!)
    return { rows: [], rowCount: 1 }
  }, release() {} }
  const install = createWebClawHubInstaller({ pool: { connect: async () => client } as unknown as Pool,
    dataRoot: root, async download() { return new Map([
      ['SKILL.md', Buffer.from('---\nname: 示例\ndescription: 描述\n---\n正文')],
      ['references/a.md', Buffer.from('资料')],
    ]) }, async publish() {} })
  try {
    assert.deepEqual(await install(owner, 'sample/demo', 'editor', new AbortController().signal), { id: 'demo' })
    assert.equal(await readFile(join(target, 'references/a.md'), 'utf8'), '资料')
    assert.equal(records.length, 1)
    assert.equal(records[0]![4], 'skills')
    assert.equal(records[0]![5], 'install')
    await assert.rejects(install(owner, 'sample/demo', 'editor', new AbortController().signal), { code: 'conflict' })
    assert.equal(await readFile(join(target, 'references/a.md'), 'utf8'), '资料')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Web 安装登记失败时恢复暂存并清理，避免留下未记录的技能', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-web-skill-fail-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const client = { async query(sql: string) {
    if (sql.includes('INSERT INTO undo_operations')) throw new Error('合成事务失败')
    return { rows: [], rowCount: 1 }
  }, release() {} }
  const install = createWebClawHubInstaller({ pool: { connect: async () => client } as unknown as Pool,
    dataRoot: root, async download() { return new Map([['SKILL.md', Buffer.from('---\nname: 示例\ndescription: 描述\n---\n正文')]]) },
    async publish() { throw new Error('不应通知') } })
  try {
    await assert.rejects(install(owner, 'sample/demo', 'editor', new AbortController().signal), /合成事务失败/)
    await assert.rejects(readFile(join(root, owner, '.agent', 'skills', 'demo', 'SKILL.md')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
