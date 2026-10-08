import { describe, expect, it } from 'vitest'
import { groupSkillsByManager } from '@/views/Skills/skillGroups'

describe('groupSkillsByManager', () => {
  it('把助手创建的技能单独归组，旧记录和未标记记录仍归用户', () => {
    const skills = [
      { slug: 'legacy' },
      { slug: 'user', managed_by: 'user' },
      { slug: 'assistant', managed_by: 'assistant' },
    ]

    const groups = groupSkillsByManager(skills)

    expect(groups.user.map(skill => skill.slug)).toEqual(['legacy', 'user'])
    expect(groups.assistant.map(skill => skill.slug)).toEqual(['assistant'])
  })
})
