import { type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { Database } from '../data/schema.js'
import { extractMindReferences } from '../mind/note-read.js'

export interface ClientRelatedItem {
  type: 'project' | 'note' | 'canvas'
  id: number
  title: string
  updatedAt: string
}

export async function readDesktopClientRelated(db: Kysely<Database>, rawOwner: string, id: number): Promise<ClientRelatedItem[]> {
  const owner = dataContext(rawOwner).ownerId.replaceAll('-', '')
  const contact = await db.selectFrom('clients').select('name')
    .where('user_id', '=', owner).where('id', '=', id).executeTakeFirst()
  if (!contact) return []
  const mentions = (markdown: string) => extractMindReferences(markdown).some(ref => ref.type === 'client' && ref.id === id)
  const [projects, notes, canvases] = await Promise.all([
    db.selectFrom('projects').select(['id', 'name as title', 'updated_at as updatedAt'])
      .where('user_id', '=', owner).where('deleted_at', 'is', null).where('contact_name', '=', contact.name).execute(),
    db.selectFrom('mind_nodes').select(['id', 'title', 'updated_at as updatedAt', 'content_md'])
      .where('user_id', '=', owner).where('deleted_at', 'is', null).where('kind', '=', 'note')
      .where('content_md', 'like', '%[[client:%').execute(),
    db.selectFrom('mind_canvas_items as i').innerJoin('mind_maps as c', 'c.id', 'i.canvas_id')
      .innerJoin('mind_nodes as n', 'n.id', 'i.node_id')
      .select(['c.id', 'c.title', 'c.updated_at as updatedAt', 'n.ref_type', 'n.ref_id', 'n.content_md'])
      .where('i.user_id', '=', owner).where('c.user_id', '=', owner).where('n.user_id', '=', owner)
      .where('i.deleted_at', 'is', null).where('c.deleted_at', 'is', null).where('n.deleted_at', 'is', null)
      .where(eb => eb.or([
        eb.and([eb('n.ref_type', '=', 'client'), eb('n.ref_id', '=', id)]),
        eb('n.content_md', 'like', '%[[client:%'),
      ])).execute(),
  ])
  const relatedCanvases = new Map<number, ClientRelatedItem>()
  for (const row of canvases) {
    if ((row.ref_type === 'client' && Number(row.ref_id) === id) || mentions(row.content_md))
      relatedCanvases.set(Number(row.id), { type: 'canvas', id: Number(row.id), title: row.title, updatedAt: row.updatedAt })
  }
  return [
    ...projects.map(row => ({ ...row, id: Number(row.id), type: 'project' as const })),
    ...notes.filter(row => mentions(row.content_md)).map(row => ({
      type: 'note' as const, id: Number(row.id), title: row.title || '无标题笔记', updatedAt: row.updatedAt,
    })),
    ...relatedCanvases.values(),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)
}
