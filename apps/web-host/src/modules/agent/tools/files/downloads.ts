import { agentDownloadsLimit, saveAgentDownload as saveToDisk, type ToolScope } from '@gugu/core/tools'
import type { ToolCall } from '@gugu/core/agent'
import { personalFileRootPath } from '../../../workspaces/roots.js'

export { agentDownloadsLimit }

export function saveAgentDownload(
  storageRoot: string, name: string, data: AsyncIterable<Uint8Array>, scope: ToolScope, call: ToolCall,
  authorize: () => Promise<boolean>,
  folderPath?: string,
) {
  const folder = folderPath ?? 'download'
  return saveToDisk(storageRoot, `${personalFileRootPath(scope.identity.ownerId)}/${folder}`, name, data, scope, call, authorize, `/personal/${folder}`, folderPath === undefined)
}
