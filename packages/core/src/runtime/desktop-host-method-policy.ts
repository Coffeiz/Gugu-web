const fixedMethods = new Set([
  'network.resolveProxy',
  'agent.memory.resolveReflectionModel',
  'agent.memory.resolveEmbedding',
  'agent.log.append',
  'agent.tools.policy',
  'agent.shell.trash',
  'agent.schedules.model',
  'agent.schedules.im.privateTarget',
  'agent.schedules.im.decodeGroup',
  'agent.schedules.im.groupCatalog',
  'agent.schedules.im.authorize',
  'agent.schedules.im.deliver',
])

const allowedPatterns = [
  /^agent\.files\.(?:overview|projectOverview|projectPath|projectWorkspaceBinding|openFolder|deleteItem|libraryFileReference|resolve|present|resolveDroppedReference|resolveWorkspaceReference|workspaceList|workspaceInstructions|globalSearch|downloadTarget|commitDownload|saveAttachment|recordSkillHistory|acquireSkillLock|releaseSkillLock)$/u,
  /^agent\.im\.(?:snapshot|authorizeGroupTool|readGroupMemoryContext|sendAttachment)$/u,
  /^agent\.search\.(?:deep_research|similar_image_search)(?:\.available)?$/u,
  /^agent\.email\.(?:accounts|attachments|list|send)$/u,
]

/** Core Worker 只允许调用桌面主进程明确提供的 Agent 宿主能力。 */
export function isAllowedDesktopAgentHostRequest(method: string): boolean {
  return fixedMethods.has(method) || allowedPatterns.some(pattern => pattern.test(method))
}
