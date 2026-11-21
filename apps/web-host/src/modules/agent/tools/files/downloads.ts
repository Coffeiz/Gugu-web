import { agentDownloadsLimit, saveAgentDownload as saveToDisk, type ToolScope } from '@gugu/core/tools'
import type { ToolCall } from '@gugu/core/agent'
import { personalFileStorageKey } from '../../../workspaces/roots.js'

export { agentDownloadsLimit }

export function saveAgentDownload(
  storageRoot: string, name: string, data: AsyncIterable<Uint8Array>, scope: ToolScope, call: ToolCall,
  authorize: () => Promise<boolean>,
) {
  return saveToDisk(storageRoot, `${personalFileStorageKey(scope.identity.ownerId)}/下载`, name, data, scope, call, authorize)
}
