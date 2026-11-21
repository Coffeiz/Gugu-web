const fixedMethods = new Set([
  'network.resolveProxy',
  'agent.memory.resolveReflectionModel',
  'agent.memory.resolveEmbedding',
  'agent.log.append',
  'agent.tools.policy',
])

const allowedPatterns = [
  /^agent\.files\.(?:overview|projectOverview|resolve|present|resolveDroppedReference|resolveWorkspaceReference|workspaceList|globalSearch|downloadTarget|commitDownload|saveAttachment)$/u,
  /^agent\.im\.(?:snapshot|authorizeGroupTool|readGroupMemoryContext)$/u,
  /^agent\.search\.(?:deep_research|similar_image_search)(?:\.available)?$/u,
  /^agent\.email\.(?:accounts|attachments|send)$/u,
]

/** Core Worker 只允许调用桌面主进程明确提供的 Agent 宿主能力。 */
export function isAllowedDesktopAgentHostRequest(method: string): boolean {
  return fixedMethods.has(method) || allowedPatterns.some(pattern => pattern.test(method))
}
