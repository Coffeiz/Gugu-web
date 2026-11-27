import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { createUserSkillBundle, readUserSkillBundle } from '@gugu/core/skills'
import { createWebFileSkillUpdater } from '../../src/modules/skills/file-update.js'

test('Web 文件技能更新保留厂商元数据并登记撤销，过期版本不会覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-web-skill-update-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  let fail = false
  const records: unknown[][] = []
  const client = { async query(query: string, values?: unknown[]) {
    if (query.includes('INSERT INTO undo_operations')) {
      if (fail) throw new Error('合成登记失败')
      records.push(values!)
    }
    return { rows: [], rowCount: 1 }
  }, release() {} }
  const update = createWebFileSkillUpdater({ pool: { connect: async () => client } as unknown as Pool,
    dataRoot: root, async publish() {} })
  try {
    const original = await createUserSkillBundle(root, owner, 'demo', '---\nname: 示例\ndescription: 描述\nmetadata:\n  upstream: 保留\n---\n正文')
    const result = await update(owner, 'demo', original.contentDigest, { enabled: false }, 'editor')
    const changed = await readUserSkillBundle(root, owner, 'demo')
    assert.equal(changed.contentDigest, result.content_digest)
    assert.deepEqual(changed.metadata.metadata, { upstream: '保留', gugu: { enabled: false } })
    assert.equal(records[0]![5], 'update')
    await assert.rejects(update(owner, 'demo', original.contentDigest, { enabled: true }, 'editor'), { code: 'conflict' })
    fail = true
    await assert.rejects(update(owner, 'demo', changed.contentDigest, { enabled: true }, 'editor'), /合成登记失败/)
    assert.equal(await readFile(join(changed.path, 'SKILL.md'), 'utf8'), changed.source)
  } finally { await rm(root, { recursive: true, force: true }) }
})
