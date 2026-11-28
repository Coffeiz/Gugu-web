import { createHash } from 'node:crypto'
import { sql, type Transaction } from 'kysely'
import { z } from 'zod'
import { CoreError } from '../contracts/index.js'
import type { Database } from '../data/schema.js'
import { imMemoryScopeFileKey, type ImMemoryScopeFile } from '../im/memory-source.js'
import type { DesktopMemoryFiles } from '../agent/memory/desktop-files.js'

const indexRow = z.strictObject({
  platform: z.enum(['qq', 'wechat', 'feishu', 'telegram']), bot_id: z.string().min(1).max(256),
  scope_type: z.enum(['group', 'platform-user']), scope_id: z.string().min(1).max(512), deleted: z.boolean(),
})

export async function restoreDesktopImMemory(
  tx: Transaction<Database>, owner: string, ownerId: string,
  entries: AsyncIterable<{ path: string; body: string; records: number }>,
  disk?: DesktopMemoryFiles,
) {
  const scopes = new Map<string, ImMemoryScopeFile>()
  const deleted = new Set<string>()
  let added = 0
  let skipped = 0
  for await (const entry of entries) {
    try {
      if (entry.path.endsWith('.jsonl')) {
        const lines = entry.body.split(/\r?\n/u).filter(Boolean)
        if (lines.length !== entry.records) throw new Error()
        for (const line of lines) {
          const { deleted: tombstone, ...row } = indexRow.parse(JSON.parse(line))
          const hash = createHash('sha256').update([row.platform, row.bot_id, row.scope_type, row.scope_id].join('\0')).digest('hex').slice(0, 32)
          const scope = { ...row, owner_user_id: ownerId }
          imMemoryScopeFileKey(scope, 'summary.json')
          if (tombstone) deleted.add(hash)
          else scopes.set(hash, scope)
        }
        continue
      }
      const parts = entry.path.split('/')
      const hash = parts[3]!
      const filename = parts[4]!
      const scope = scopes.get(hash)
      if (!scope || deleted.has(hash)) throw new Error()
      imMemoryScopeFileKey(scope, filename)
      if (filename.endsWith('.json')) {
        const data: unknown = JSON.parse(entry.body)
        if (data === null || typeof data !== 'object') throw new Error()
      }
      const { platform, bot_id, scope_type, scope_id } = scope
      const tombstone = await sql`SELECT 1 FROM desktop_im_memory_tombstones WHERE owner_id=${owner}
        AND platform=${platform} AND bot_id=${bot_id} AND scope_type=${scope_type} AND scope_id=${scope_id}`.execute(tx)
      if (tombstone.rows.length || (disk && await disk.readImScope(scope, filename) !== null)) {
        skipped++
        continue
      }
      const saved = await sql`INSERT INTO desktop_imported_im_memory(owner_id,platform,bot_id,scope_type,scope_id,filename,body)
        VALUES(${owner},${platform},${bot_id},${scope_type},${scope_id},${filename},${entry.body})
        ON CONFLICT DO NOTHING RETURNING filename`.execute(tx)
      if (saved.rows.length) added++
      else skipped++
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError || error instanceof TypeError
        || (error instanceof Error && !error.message)) throw new CoreError('invalid_request', '归档中的 IM 记忆格式或作用域无效')
      throw error
    }
  }
  return { added, skipped }
}
