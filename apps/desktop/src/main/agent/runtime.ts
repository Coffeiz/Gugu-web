import { fileURLToPath } from 'node:url'
import type { DesktopAgentRuntimeModule } from '#core-source/runtime/desktop-agent-port.js'
import { CoreError } from '#core-source/contracts/index.js'
import { createDesktopAgentRuns as createRuns } from './runtime/runner.js'

export { CoreError as DesktopAgentCoreError }

type RuntimeArgs = Parameters<typeof createRuns>

export function createDesktopAgentRuns(
  core: RuntimeArgs[0], databasePath: RuntimeArgs[1], ownerId: RuntimeArgs[2],
  notify: RuntimeArgs[3], hostRequest: RuntimeArgs[4],
  memoryFiles?: RuntimeArgs[5], observation?: RuntimeArgs[6],
  promptDirectory = fileURLToPath(new URL('../agent-prompts/', import.meta.url)),
) {
  return createRuns(core, databasePath, ownerId, notify, hostRequest, memoryFiles, observation, promptDirectory)
}

export const desktopAgentRuntimeModule = {
  createDesktopAgentRuns,
  DesktopAgentCoreError: CoreError,
} satisfies DesktopAgentRuntimeModule
