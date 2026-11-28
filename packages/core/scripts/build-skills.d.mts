export interface DiscoveredSkillDocument {
  readonly name: string
  readonly content: string
}

export function discoverSkillDocuments(sourceDirectory: string): Promise<DiscoveredSkillDocument[]>
