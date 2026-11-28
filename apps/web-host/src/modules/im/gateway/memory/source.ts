import type { ContextDataPorts, RunIdentity } from '@gugu/core/agent'
import type { ImActor } from '@gugu/core/im/access'
import { createImMemoryContextSource, imMemoryScopeFileKey, ImMemorySourceError,
  type ImMemoryReadAuthorization, type ImMemoryScopeFile } from '@gugu/core/im/memory-source'
import { createLocalImMemoryMaintenanceStorage } from '../../../admin/memory-apply.js'

export type ImMemoryReadScope = ImMemoryScopeFile
export { ImMemorySourceError }
export type { ImMemoryReadAuthorization }

/** Web Host 只注入本地文件存储与 PostgreSQL 墓碑查询；读取策略由 Core 共享。 */
export function createLocalImMemorySource(options: {
  root: string; identity: RunIdentity; actor: ImActor
  authorize(identity: RunIdentity, actor: ImActor): Promise<ImMemoryReadAuthorization | null>
  isTombstoned(scope: ImMemoryReadScope): Promise<boolean>
}): Pick<ContextDataPorts, 'loadImMemory'> {
  if (typeof options.root !== 'string' || !options.root.trim()) throw new ImMemorySourceError('invalid_scope')
  const storage = createLocalImMemoryMaintenanceStorage(options.root)
  return createImMemoryContextSource({ identity: options.identity, actor: options.actor,
    authorize: options.authorize, isTombstoned: options.isTombstoned,
    readText: (scope, filename) => storage.read(imMemoryScopeFileKey(scope, filename)),
  })
}
