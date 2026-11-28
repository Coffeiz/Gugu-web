import type { ImActor } from '#core-source/im/access.js'
import type { ImMemoryReadAuthorization } from '#core-source/im/memory-source.js'

export function desktopGroupMemoryContext(value: unknown, ownerId: string): (ImMemoryReadAuthorization & { actor: ImActor; ownerPlatformUserId: string | null }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>, actorValue = row.actor
  if (!actorValue || typeof actorValue !== 'object' || Array.isArray(actorValue)) return null
  const actor = actorValue as Record<string, unknown>
  if (actor.ownerId !== ownerId || !['feishu', 'qq', 'telegram'].includes(String(actor.platform)) || typeof actor.botId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,256}$/u.test(actor.botId) || actor.chatType !== 'group' || typeof actor.chatId !== 'string' || !actor.chatId
    || typeof actor.platformUserId !== 'string' || !actor.platformUserId
    || !['owner', 'member', 'unknown'].includes(String(actor.role))
    || !Array.isArray(actor.allowedToolNames) && actor.allowedToolNames !== null
    || Array.isArray(actor.allowedToolNames) && actor.allowedToolNames.some(name => typeof name !== 'string')
    || actor.speakerRoles !== null && (!Array.isArray(actor.speakerRoles) || actor.speakerRoles.some(item => !item || typeof item !== 'object'
      || typeof (item as Record<string, unknown>).platformUserId !== 'string'
      || !['owner', 'member', 'unknown'].includes(String((item as Record<string, unknown>).role))))
    || typeof actor.verifiedOwner !== 'boolean' || typeof actor.ownerMentionAuthorized !== 'boolean'
    || typeof row.groupMemoryEnabled !== 'boolean' || typeof row.memberMemoryEnabled !== 'boolean'
    || typeof row.groupOwnerMemoryEnabled !== 'boolean') return null
  return { ownerId, botId: actor.botId, platform: actor.platform as ImActor['platform'], chatType: 'group', chatId: actor.chatId,
    platformUserId: actor.platformUserId, groupMemoryEnabled: row.groupMemoryEnabled, memberMemoryEnabled: row.memberMemoryEnabled,
    groupOwnerMemoryEnabled: row.groupOwnerMemoryEnabled,
    ownerPlatformUserId: typeof row.ownerPlatformUserId === 'string' && row.ownerPlatformUserId ? row.ownerPlatformUserId : null,
    actor: actor as unknown as ImActor }
}
