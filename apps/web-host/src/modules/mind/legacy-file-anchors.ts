import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { CoreError } from '@gugu/core'
import { createWorkspaceFileReads, type FileDirectory } from '../workspaces/files.js'

type LegacyFileReference = QueryResultRow & {
  id: number
  user_id: string
  ref_id?: number
  space: string | null
  project_id: number | null
  workspace_directory_id: number | null
  storage_key: string | null
}

type LegacyMindContent = QueryResultRow & { id: number; user_id: string; content_md: string }
type LegacyMessageContent = QueryResultRow & { id: number; user_id: string; content: string }

function visibleMarkdown(markdown: string): string {
  return markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)[\s\S]*?^ {0,3}\1[`~]*[ \t]*(?:\r?$|$)/gmu, value => ' '.repeat(value.length))
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, value => ' '.repeat(value.length))
}

function legacyFileLinks(markdown: string): Array<{ start: number; end: number; id: number; label: string; syntax: 'wiki' | 'markdown' }> {
  const visible = visibleMarkdown(markdown)
  const links: Array<{ start: number; end: number; id: number; label: string; syntax: 'wiki' | 'markdown' }> = []
  const patterns = [
    { regex: /\[\[file:([1-9]\d{0,9})\|([^\]]*)\]\]/gu, id: 1, label: 2, syntax: 'wiki' as const },
    { regex: /\[([^\[\]\r\n]+)\]\(gugu:\/\/open-object\/file\/([1-9]\d{0,9})\)/gu, id: 2, label: 1, syntax: 'markdown' as const },
  ]
  for (const pattern of patterns) {
    for (const match of visible.matchAll(pattern.regex)) {
      const start = match.index!
      let slash = start - 1
      while (slash >= 0 && visible[slash] === '\\') slash--
      if ((start - 1 - slash) % 2) continue
      const rawId = match[pattern.id]
      const id = Number(rawId)
      if (!Number.isSafeInteger(id) || id < 1) continue
      links.push({ start, end: start + match[0].length, id, label: match[pattern.label] ?? '', syntax: pattern.syntax })
    }
  }
  return links.sort((left, right) => left.start - right.start)
}

function fileReferenceLocation(row: LegacyFileReference): { directory: FileDirectory; relativePath: string } | null {
  if (!row.storage_key) return null
  const parts = row.storage_key.split('/')
  if (parts[0] !== row.user_id.toLowerCase()) return null
  if (row.space === 'personal' && parts.length > 2 && parts[1] === '个人文件')
    return { directory: 'personal', relativePath: parts.slice(2).join('/') }
  if (row.space === 'project' && Number.isSafeInteger(row.project_id) && Number(row.project_id) > 0
    && parts.length > 5 && parts[1] === '项目文件')
    return { directory: { projectId: Number(row.project_id) }, relativePath: parts.slice(5).join('/') }
  if (row.space === 'workspace' && Number.isSafeInteger(row.workspace_directory_id) && Number(row.workspace_directory_id) > 0
    && parts.length > 3 && parts[1] === 'workspace')
    return { directory: Number(row.workspace_directory_id), relativePath: parts.slice(3).join('/') }
  return null
}

async function rewriteLegacyFileLinks(
  client: PoolClient, reads: ReturnType<typeof createWorkspaceFileReads>, owner: string, content: string,
): Promise<string> {
  const links = legacyFileLinks(content)
  if (!links.length) return content
  const ids = [...new Set(links.map(link => link.id))]
  const found = await client.query<LegacyFileReference>(
    `SELECT file.id,file.user_id,file.space,file.project_id,file.workspace_directory_id,file.storage_key
     FROM files file WHERE file.user_id=$1 AND file.id=ANY($2::integer[]) AND file.deleted_at IS NULL`,
    [owner, ids],
  )
  const references = new Map<number, string>()
  for (const file of found.rows) {
    const location = fileReferenceLocation(file)
    if (!location) continue
    try {
      const resolved = await reads.reference(owner, location.directory, location.relativePath)
      if (resolved.type === 'file') references.set(Number(file.id), resolved.id)
    } catch (error) {
      if (!(error instanceof CoreError) || error.code !== 'not_found') throw error
    }
  }
  let next = content
  for (const link of [...links].reverse()) {
    const replacement = references.get(link.id)
    const value = replacement
      ? link.syntax === 'wiki' ? `[[file:${replacement}|${link.label}]]` : `[${link.label}](gugu://open-object/file/${replacement})`
      : link.label
    next = next.slice(0, link.start) + value + next.slice(link.end)
  }
  return next
}

/** 将存量 Mind 文件引用从 files.id 迁为当前磁盘路径引用。 */
export async function migrateLegacyMindFileAnchors(pool: Pick<Pool, 'connect' | 'query'>, storageRoot: string): Promise<number> {
  const legacy = await pool.query<{ has_legacy_file_id: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='files' AND column_name='id')
       AND to_regclass('mind_nodes') IS NOT NULL AS has_legacy_file_id`,
  )
  if (!legacy.rows[0]?.has_legacy_file_id) return 0
  const reads = createWorkspaceFileReads(pool, storageRoot)
  const client = await pool.connect()
  let begun = false
  try {
    await client.query('BEGIN')
    begun = true
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gugu-mind-file-path-migration'))")
    const selected = await client.query<LegacyFileReference>(
      `SELECT node.id,node.user_id,node.ref_id,file.space,file.project_id,file.workspace_directory_id,file.storage_key
       FROM mind_nodes node
       LEFT JOIN files file ON file.id=node.ref_id AND file.user_id=node.user_id
       WHERE node.kind='ref' AND node.ref_type='file' AND node.ref_id>0 AND node.deleted_at IS NULL
       ORDER BY node.user_id,node.id FOR UPDATE OF node`,
    )
    let migrated = 0
    let owner: string | null = null
    let nextRef = 0
    for (const row of selected.rows) {
      if (row.user_id !== owner) {
        owner = row.user_id
        const result = await client.query<{ next_ref: number }>(
          "SELECT COALESCE(MIN(ref_id),0)-1 AS next_ref FROM mind_nodes WHERE user_id=$1 AND ref_type='file' AND ref_id<0",
          [owner],
        )
        nextRef = Number(result.rows[0]?.next_ref ?? -1)
      }
      const location = fileReferenceLocation(row)
      let fileReferenceId: string | null = null
      if (location) {
        try {
          const resolved = await reads.reference(row.user_id, location.directory, location.relativePath)
          if (resolved.type === 'file') fileReferenceId = resolved.id
        } catch (error) {
          // 缺失或已进回收站的文件不保留不可解析的数据库行号引用。
          if (!(error instanceof CoreError) || error.code !== 'not_found') throw error
        }
      }
      if (fileReferenceId) {
        await client.query(
          `UPDATE mind_nodes SET ref_id=$3,ref_snapshot=$4::json,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2 AND ref_type='file' AND ref_id=$5`,
          [row.id, row.user_id, nextRef, JSON.stringify({ fileReferenceId }), row.ref_id],
        )
      } else {
        await client.query(
          `UPDATE mind_nodes SET ref_id=$3,ref_snapshot='{"unavailable":true}'::json,
             deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2 AND ref_type='file' AND ref_id=$4`,
          [row.id, row.user_id, nextRef, row.ref_id],
        )
      }
      nextRef--
      migrated++
    }
    const contentRows = await client.query<LegacyMindContent>(
      `SELECT id,user_id,content_md FROM mind_nodes
       WHERE deleted_at IS NULL AND (content_md ~ '\\[\\[file:[1-9][0-9]{0,9}\\|'
          OR content_md ~ 'gugu://open-object/file/[1-9][0-9]{0,9}')
       ORDER BY user_id,id FOR UPDATE`,
    )
    for (const row of contentRows.rows) {
      const next = await rewriteLegacyFileLinks(client, reads, row.user_id, row.content_md)
      if (next !== row.content_md) {
        await client.query(
          `UPDATE mind_nodes SET content_md=$3,version=version+1,indexed_at=NULL,indexed_hash=NULL,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND user_id=$2`,
          [row.id, row.user_id, next],
        )
        migrated++
      }
    }
    const messages = await client.query<LegacyMessageContent>(
      `SELECT message.id,session.user_id,message.content FROM conversation_messages message
       JOIN conversation_sessions session ON session.id=message.session_id
       WHERE message.content ~ '\\[\\[file:[1-9][0-9]{0,9}\\|'
          OR message.content ~ 'gugu://open-object/file/[1-9][0-9]{0,9}'
       ORDER BY session.user_id,message.id FOR UPDATE OF message`,
    )
    for (const row of messages.rows) {
      const next = await rewriteLegacyFileLinks(client, reads, row.user_id, row.content)
      if (next === row.content) continue
      await client.query('UPDATE conversation_messages SET content=$3 WHERE id=$1 AND session_id IN (SELECT id FROM conversation_sessions WHERE user_id=$2)',
        [row.id, row.user_id, next])
      migrated++
    }
    await client.query('COMMIT')
    begun = false
    return migrated
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
