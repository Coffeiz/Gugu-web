import type { PublicUserRecord } from './auth.js'

export function userResponse(user: PublicUserRecord) {
  const createdAt = user.createdAt instanceof Date
    ? user.createdAt.toISOString().slice(0, 10)
    : user.createdAt?.slice(0, 10) ?? ''
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    isActive: user.isActive,
    avatarUrl: user.avatarUrl,
    createdAt,
    imChannels: user.imChannels,
    timezone: user.timezone,
    emailSubscribed: user.emailSubscribed,
  }
}
