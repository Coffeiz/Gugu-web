import { sql, type Transaction } from 'kysely'
import { z } from 'zod'
import { CoreError } from '../contracts/index.js'
import type { Database } from '../data/schema.js'
import type { DesktopMemoryFiles } from '../agent/memory/desktop-files.js'

const memoryRows = z.array(z.object({ text: z.string() }).passthrough())
const document = z.record(z.string(), z.unknown())

function readMemoryRows(body: string) {
  try { return memoryRows.parse(JSON.parse(body)) }
  catch { throw new CoreError('invalid_request', '个人记忆条目格式无效') }
}

export async function restoreDesktopOwnerMemory(
  tx: Transaction<Database>, owner: string, files: ReadonlyMap<string, string>,
  disk?: Pick<DesktopMemoryFiles, 'readTarget'>,
) {
  let added = 0
  let skipped = 0
  const legacy = (name: string) => files.get('memory/legacy/' + name)
  for (const target of ['profile', 'pattern', 'daily', 'memory', 'summary', 'stance', 'lens'] as const) {
    const json = target !== 'daily' && target !== 'memory'
    let body = files.get('memory/owner/' + target + (json ? '.json' : '.md'))
    if (target === 'pattern' && body === undefined) {
      body = legacy('facts.json')
      if (body === undefined && legacy('facts.md') !== undefined)
        body = JSON.stringify(legacy('facts.md')!.split(/\r?\n/u).map(text => text.trim()).filter(Boolean).map(text => ({ text })))
    }
    if (target === 'summary' && body === undefined && legacy('summary.md') !== undefined) {
      const ts = Number(legacy('summary.ts'))
      body = JSON.stringify({ text: legacy('summary.md'), ts: Number.isFinite(ts) ? ts : null })
    }
    if (body === undefined) continue
    if (target === 'profile' || target === 'pattern') {
      const incoming = readMemoryRows(body)
      const queued = await sql<{ body: string }>`SELECT body FROM desktop_agent_memory
        WHERE user_id=${owner} AND target=${target}`.execute(tx)
      const current = readMemoryRows(queued.rows[0]?.body ?? await disk?.readTarget(target) ?? '[]')
      const seen = new Set(current.map(row => row.text.trim()))
      const newRows = incoming.filter(row => {
        const key = row.text.trim()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!newRows.length) { skipped++; continue }
      const merged = JSON.stringify([...current, ...newRows])
      if (Buffer.byteLength(merged) > 2_000_000) throw new CoreError('invalid_request', '合并后的个人记忆超过大小限制')
      await sql`INSERT INTO desktop_agent_memory(user_id,target,body) VALUES(${owner},${target},${merged})
        ON CONFLICT(user_id,target) DO UPDATE SET body=excluded.body`.execute(tx)
      added++
      continue
    }
    if (json) {
      try {
        document.parse(JSON.parse(body))
      } catch {
        throw new CoreError('invalid_request', '归档中的个人记忆格式无效')
      }
    }
    const present = await sql`SELECT 1 FROM desktop_agent_memory_documents WHERE user_id=${owner} AND target=${target}`.execute(tx)
    if (present.rows.length || await disk?.readTarget(target) !== undefined) {
      skipped++
      continue
    }
    await sql`INSERT INTO desktop_agent_memory_documents(user_id,target,body) VALUES(${owner},${target},${body})`.execute(tx)
    added++
  }
  return { added, skipped }
}
