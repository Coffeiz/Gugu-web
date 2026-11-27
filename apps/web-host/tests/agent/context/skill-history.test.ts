import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { HistoryReaderPort } from '@gugu/core/agent'
import { createUserSkillBundle } from '@gugu/core/skills'
import { withAgentHistoryReferences } from '../../../src/modules/agent/context/history.js'

test('历史文件技能引用通过当前用户目录恢复，不能读取其他用户技能', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-history-'))
  const owner = randomUUID(), other = randomUUID()
  try {
    await createUserSkillBundle(root, owner, 'example', '---\nname: 示例技能\ndescription: 示例描述\n---\n正文')
    const pool = { async query() { return { rows: [{ id: '9', references_json: [{ type: 'skill', id: 'example', label: '示例' }] }] } } } as unknown as Pick<Pool, 'query'>
    const base: HistoryReaderPort = { async read() { throw new Error('不应读取') } }
    const history = withAgentHistoryReferences(pool, base, root)
    const row = { ownerId: owner, sessionId: '1', id: '9', conversationSeq: 1, role: 'user' as const, content: '问题' }
    const result = await history.hydrateReferences!({ ownerId: owner, sessionId: '1' }, [row])
    const content = JSON.stringify(result[0]?.contentJson)
    assert.match(content, /示例技能/u)
    assert.match(content, /\/workspace\/\.agent\/skills\/example/u)
    const otherRow = { ...row, ownerId: other }
    const otherResult = await history.hydrateReferences!({ ownerId: other, sessionId: '1' }, [otherRow])
    assert.equal(otherResult[0]?.contentJson, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})
