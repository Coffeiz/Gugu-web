import { z } from 'zod'
import { sql, type Kysely } from 'kysely'
import { desktopScheduleImTarget, ownsDesktopScheduleImTarget } from './desktop-im.js'

export async function readDesktopScheduledGroups<DB>(db: Kysely<DB>, ownerId: string, platform: string,
  decode: (receipt: Record<string, string>) => Promise<unknown>) {
  const owner = ownerId.replaceAll('-', '')
  const { rows } = await sql<{ connection_id: string; event_key: string; sealed_event: Buffer; title: string }>`
    SELECT im.connection_id, i.event_key, i.sealed_event, s.title
    FROM desktop_im_sessions im
    JOIN conversation_sessions s ON s.id=im.session_id AND s.user_id=im.owner_id AND s.chat_type='group'
    JOIN desktop_im_inbox i ON i.rowid=(SELECT candidate.rowid FROM desktop_im_inbox candidate
      WHERE candidate.owner_id=im.owner_id AND candidate.platform=im.platform AND candidate.connection_id=im.connection_id
      ORDER BY candidate.received_at DESC, candidate.rowid DESC LIMIT 1)
    WHERE im.owner_id=${owner} AND im.platform=${platform}
    ORDER BY i.received_at DESC LIMIT 50`.execute(db)
  const groups = await Promise.all(rows.map(async row => {
    const target = desktopScheduleImTarget.safeParse(await decode({
      platform, connectionId: row.connection_id, eventKey: row.event_key, sealedEvent: row.sealed_event.toString('base64'),
    }))
    return target.success && target.data.chatType === 'group' && target.data.platform === platform
      && await ownsDesktopScheduleImTarget<DB>(db, ownerId, target.data)
      ? { target: target.data, title: row.title } : null
  }))
  return groups.filter(group => group !== null)
}

export const desktopScheduledGroupCatalog = z.array(z.object({ target: desktopScheduleImTarget, title: z.string() })).max(50)

export async function readHostedScheduledGroups(platform: string, load: () => Promise<unknown>) {
  const catalog = desktopScheduledGroupCatalog.safeParse(await load())
  return catalog.success
    ? catalog.data.filter(entry => entry.target.platform === platform && entry.target.chatType === 'group')
    : []
}

export function matchesScheduledGroup(left: import('./desktop-im.js').DesktopScheduleImTarget,
  right: import('./desktop-im.js').DesktopScheduleImTarget) {
  return left.chatType === 'group' && right.chatType === 'group' && left.platform === right.platform
    && left.botId === right.botId && left.boundUserId === right.boundUserId && left.recipient === right.recipient
}
