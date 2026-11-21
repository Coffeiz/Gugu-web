import { describe, expect, it } from 'vitest'
import { groupSkillsByManager } from '@/views/Skills/skillGroups'

describe('groupSkillsByManager', () => {
  it('把助手创建的技能单独归组，旧记录和未标记记录仍归用户', () => {
    const skills = [
      { id: 'U1' },
      { id: 'U2', managed_by: 'user' },
      { id: 'U3', managed_by: 'assistant' },
    ]

    const groups = groupSkillsByManager(skills)

    expect(groups.user.map(skill => skill.id)).toEqual(['U1', 'U2'])
    expect(groups.assistant.map(skill => skill.id)).toEqual(['U3'])
  })
})
