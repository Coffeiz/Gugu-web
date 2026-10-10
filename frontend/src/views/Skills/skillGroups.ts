export interface SkillManagementGroup<T> {
  user: T[]
  assistant: T[]
}

export function groupSkillsByManager<T extends { managed_by?: string | null }>(skills: readonly T[]): SkillManagementGroup<T> {
  const groups: SkillManagementGroup<T> = { user: [], assistant: [] }
  for (const skill of skills) {
    if (skill.managed_by === 'assistant') groups.assistant.push(skill)
    else groups.user.push(skill)
  }
  return groups
}
