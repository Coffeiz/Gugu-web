export const AVATAR_MAX_BYTES = 5 * 1024 * 1024

const extensionByMediaType = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const

export type AvatarMediaType = keyof typeof extensionByMediaType

export function isAvatarMediaType(mediaType: string): mediaType is AvatarMediaType {
  return Object.hasOwn(extensionByMediaType, mediaType)
}

export function avatarFileExtension(mediaType: AvatarMediaType): string {
  return extensionByMediaType[mediaType]
}
