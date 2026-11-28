import { request } from '@/api/client'
import type { SearchAccess } from '@/services/searchAccess'

export const webSearchAccess: SearchAccess = {
  query(queries, signal) {
    const params = new URLSearchParams({ mode: 'OR' })
    for (const term of queries) params.append('queries', term)
    return request('GET', `/search?${params}`, null, false, signal)
  },
  queryNotes(query, signal) {
    const params = new URLSearchParams({ mode: 'OR', per_type: '200', types: 'note', queries: query })
    return request('GET', `/search?${params}`, null, false, signal)
  },
}
