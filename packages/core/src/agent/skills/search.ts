import { casefoldSearchText, type GlobalSearchSource } from '@gugu/search'
import { listUserSkillBundles } from './bundle-store.js'

/** 按当前 owner 搜索文件技能。 */
export function createFileSkillSearchSource(dataRoot: string): GlobalSearchSource {
  return {
    type: 'skill', label: '技能',
    async search(ownerId, query, signal) {
      signal?.throwIfAborted()
      const files = await listUserSkillBundles(dataRoot, ownerId)
      signal?.throwIfAborted()
      const terms = query.queries.map(casefoldSearchText)
      const candidates = files.skills.flatMap(skill => {
        const haystack = casefoldSearchText([skill.name, skill.id, skill.description_short, skill.description_long ?? ''].join(' '))
        const hits = terms.filter(term => haystack.includes(term)).length
        if (query.mode === 'AND' ? hits !== terms.length : hits === 0) return []
        return [{ id: skill.id, title: skill.name, subtitle: skill.description_short, enabled: skill.enabled, hits }]
      })
      candidates.sort((a, b) => b.hits - a.hits || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      const results = candidates.map(({ hits: _hits, ...item }) => item)
      return results.slice(0, query.perType)
    },
  }
}
