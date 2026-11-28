import { allowedUserBotTools } from '../../../../im/user-bots.js'
import type { ImActor } from '../../../../im/access.js'

const configurableTools = new Set(allowedUserBotTools)

export function imMemberAllowsTool(actor: Pick<ImActor, 'role' | 'allowedToolNames'>, name: string): boolean {
  return actor.role === 'member' && configurableTools.has(name) && actor.allowedToolNames?.includes(name) === true
}
