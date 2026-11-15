import { expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { createSqlAgentPendingQueue, QueueConflict, QueueSessionNotFound } from '../../src/agent/sessions/pending-queue.js'

export function agentQueueContract(name: string, open: () => Promise<{ db: Kysely<any>; owner: string; other: string; close(): Promise<void> }>, dialect: 'postgres' | 'sqlite') {
  it(name, async () => {
    const { db, owner, other, close } = await open()
    try {
      let now = 100, serial = 0
      const queue = createSqlAgentPendingQueue(db, dialect, { isSessionActive: async () => false, nowSeconds: () => now, createToken: () => `token-${++serial}` })
      expect(() => queue.replaceDraft(owner, 'import-invalid', [{ key: Number.MAX_SAFE_INTEGER + 1, text: '无效' }])).toThrow('队列项目无效')
      expect(() => queue.replaceDraft(owner, 'import-invalid', [{ key: 1, text: '无效', _claim_token: '伪造' }])).toThrow('队列项目无效')
      await queue.replaceDraft(owner, 'import-extra', [{ key: 2, text: '附件', attachments: [{ name: '合成', ignored: '不得保存' }] }])
      expect((await queue.readQueue(owner, 'import-extra'))?.items).toEqual([{ key: 2, text: '附件', attachments: [{ name: '合成' }], references: [], queue_id: 'import-extra', session_id: null, claimed: false }])
      await queue.replaceDraft(owner, 'import-extra', [])
      await queue.replaceDraft(owner, 'import-1', [{ key: 8, text: '草稿' }])
      const storageOwner = dialect === 'sqlite' ? owner.replaceAll('-', '') : owner
      const payload = JSON.stringify([{ key: 8, text: '草稿', _claim_token: 'draft-secret', _claim_until: 200 }])
      const json = dialect === 'postgres' ? sql`${payload}::jsonb` : sql`${payload}`
      await sql`UPDATE conversation_pending_queues SET items=${json} WHERE user_id=${storageOwner} AND queue_id='import-1'`.execute(db)
      const drafts = await queue.readImportedDrafts(owner)
      expect(drafts[0]?.items[0]?.claimed).toBe(true)
      expect(JSON.stringify(drafts)).not.toContain('draft-secret')
      expect(JSON.stringify(drafts)).not.toContain('_claim_until')
      expect((await queue.readImportedDrafts(other))).toEqual([])
      await queue.patch(owner, 'session-1', 1, [{ key: 1, text: '问题' }], [])
      await expect(queue.patch(other, 'session-1', 1, [], [])).rejects.toBeInstanceOf(QueueSessionNotFound)
      expect(() => queue.replaceDraft(owner, 'session-1', [])).toThrow(QueueConflict)
      const claims = await Promise.all([queue.claim(owner, 1, 'session-1', 1), queue.claim(owner, 1, 'session-1', 1)])
      expect(claims.filter(item => item.claimToken)).toHaveLength(1)
      const first = claims.find(item => item.claimToken)!.claimToken!
      await queue.patch(owner, 'session-1', 1, [{ key: 1, text: '更新' }], [])
      const visible = await queue.readQueue(owner, 'session-1')
      expect(visible?.items[0]?.claimed).toBe(true)
      expect(JSON.stringify(visible)).not.toContain(first)
      expect(JSON.stringify(visible)).not.toContain('_claim_until')
      now += 61
      expect((await queue.readQueue(owner, 'session-1'))?.items[0]?.claimed).toBe(false)
      const next = await queue.claim(owner, 1, 'session-1', 1)
      expect(await queue.release(owner, 1, 'session-1', 1, first)).toBe(false)
      expect(await queue.release(owner, 1, 'session-1', 1, next.claimToken!)).toBe(true)
      expect(await queue.readQueue(other, 'session-1')).toBeNull()
    } finally { await close() }
  })
}
