const DESCRIPTION_SHORT_MAX = 100

export interface CapabilityToolMetadata {
  readonly name: string
  readonly description?: string
  readonly description_short?: string
  readonly category?: string
  readonly permissions?: readonly string[]
  readonly platforms?: readonly string[]
  readonly related_skills?: readonly string[]
  readonly source?: string
  readonly enabled?: boolean
}

export interface CapabilitySkillMetadata {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly description_short?: string
  readonly category?: string
  readonly permissions?: readonly string[]
  readonly platforms?: readonly string[]
  readonly related_tools?: readonly string[]
  readonly related_skills?: readonly string[]
  readonly source?: string
  readonly enabled?: boolean
}

function list(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])]
}

function shortDescription(explicit: string | undefined, description: string | undefined, name: string): string {
  const full = description?.trim() ?? ''
  const punctuation = full.search(/[。.!?]/u)
  const value = explicit?.trim() || (punctuation >= 0 ? full.slice(0, punctuation + 1) : full.split(/[\r\n]/u, 1)[0]?.trim()) || ''
  const short = [...value].slice(0, DESCRIPTION_SHORT_MAX).join('')
  if (!short) throw new Error(`能力 ${name} 缺少短描述`)
  return short
}

/** Core 把实际注册的能力投影成 Admin 元数据；参数 Schema 和 Skill 正文始终留在执行链。 */
export function createCapabilityCatalog(input: {
  readonly tools: readonly CapabilityToolMetadata[]
  readonly skills: readonly CapabilitySkillMetadata[]
}) {
  const skillsByTool = new Map<string, string[]>()
  for (const skill of input.skills) for (const toolName of skill.related_tools ?? []) {
    const related = skillsByTool.get(toolName) ?? []
    related.push(skill.id)
    skillsByTool.set(toolName, related)
  }
  const tools = input.tools.map(item => ({
    name: item.name,
    description_short: shortDescription(item.description_short, item.description, item.name),
    category: item.category ?? '',
    permissions: list(item.permissions),
    platforms: list(item.platforms),
    related_skills: list([...(item.related_skills ?? []), ...(skillsByTool.get(item.name) ?? [])]),
    source: item.source ?? 'builtin',
    enabled: item.enabled ?? true,
  }))
  const skills = input.skills.map(item => ({
    name: item.id,
    description_short: shortDescription(item.description_short, item.description, item.id),
    category: item.category ?? '',
    permissions: list(item.permissions),
    platforms: list(item.platforms),
    related_tools: list(item.related_tools),
    related_skills: list(item.related_skills),
    source: item.source ?? 'builtin',
    enabled: item.enabled ?? true,
  }))
  return { generation: 1, diagnostics: [] as string[], tools, skills }
}
