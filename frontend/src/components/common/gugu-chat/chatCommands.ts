import { agentApi } from '@/services/api'

export interface ChatCommandOption {
  command: string
  label: string
  description: string
  insert: string
}

let commandCache: ChatCommandOption[] | null = null
let commandRequest: Promise<ChatCommandOption[]> | null = null

export function loadChatCommands(): Promise<ChatCommandOption[]> {
  if (commandCache) return Promise.resolve(commandCache)
  if (!commandRequest) {
    commandRequest = agentApi.listCommands()
      .then((data) => {
        commandCache = data.commands
        return commandCache
      })
      .finally(() => { commandRequest = null })
  }
  return commandRequest
}
