export interface UpdateProfileInput {
  readonly displayName?: string | null
  readonly timezone?: string | null
  readonly emailSubscribed?: boolean
}

export { InvalidProfileTimezoneError, prepareProfilePatch, profileTimezoneChanged, type ProfilePatch } from './profile.js'
export { AVATAR_MAX_BYTES, avatarFileExtension, isAvatarMediaType, type AvatarMediaType } from './avatar.js'
export { getProfile, updateProfile, setAvatar, InvalidAvatarError, type UserProfileRecord } from './service.js'
