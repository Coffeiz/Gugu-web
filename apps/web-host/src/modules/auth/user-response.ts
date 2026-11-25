import type { RemoteUser } from '@gugu/auth/contracts'
import { getProfile, type UserProfileRecord } from '@gugu/users'

export function userResponse(user: UserProfileRecord): RemoteUser {
  return getProfile(user)
}
