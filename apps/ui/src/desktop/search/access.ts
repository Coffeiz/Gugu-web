import type { SearchAccess } from '@/services/searchAccess'
import { desktopData } from '../bridge/bridge'

export const desktopSearchAccess: SearchAccess = {
  async query(queries, signal, expansion) {
    signal?.throwIfAborted()
    const result = await desktopData.search(queries.slice(0, 8).map(term => [...term].slice(0, 64).join('')), expansion)
    signal?.throwIfAborted()
    return result
  },
  async queryNotes(query, signal) {
    signal?.throwIfAborted()
    const normalized = query.trim().toLocaleLowerCase()
    const notes = await desktopData.notes()
    signal?.throwIfAborted()
    const items = notes.filter(note => `${note.title ?? ''}\n${note.contentMd}`.toLocaleLowerCase().includes(normalized))
      .map(note => ({ id: note.id }))
    return { groups: [{ type: 'note', items }] }
  },
}
