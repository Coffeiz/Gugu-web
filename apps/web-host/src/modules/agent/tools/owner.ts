import { createWebAgentShell } from './shell/sandbox.js'
import { createAgentDiskTrashTools } from './trash/disk.js'
import type { AgentToolRegistryOptions } from './registry.js'

type ShellOptions = Parameters<typeof createWebAgentShell>[0]
type TrashOptions = Parameters<typeof createAgentDiskTrashTools>[0]

/** 两个渠道共用工具装配，确认门和当前会话授权由宿主注入。 */
export function createOwnerFileTools(options: {
  read: ShellOptions['read']
  mounts: ShellOptions['mounts']
  shell?: Omit<ShellOptions, 'read' | 'mounts'>
  trash?: TrashOptions
  viewImage: NonNullable<AgentToolRegistryOptions['viewImage']>
}): Pick<AgentToolRegistryOptions, 'shell' | 'diskTrashTools' | 'viewImage'> {
  const { shell, trash, viewImage, read, mounts } = options
  return {
    viewImage,
    ...(shell ? { shell: createWebAgentShell({ ...shell, read, mounts }) } : {}),
    ...(trash ? { diskTrashTools: createAgentDiskTrashTools(trash) } : {}),
  }
}
