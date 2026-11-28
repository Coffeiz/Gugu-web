import type { UpdateProfileInput } from './index.js'
import { AVATAR_MAX_BYTES, isAvatarMediaType, type AvatarMediaType } from './avatar.js'

/** 资料读取可复用宿主认证时加载的账号记录。 */
export interface UserProfileRecord {
  readonly id: string
  readonly username: string
  readonly displayName: string | null
  readonly email: string
  readonly isActive: boolean
  readonly avatarUrl: string | null
  readonly createdAt: Date | string | null
  readonly timezone: string | null
  readonly emailSubscribed: boolean
  readonly imChannels: readonly string[]
}

export function getProfile(user: UserProfileRecord) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    isActive: user.isActive,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt instanceof Date
      ? user.createdAt.toISOString().slice(0, 10)
      : user.createdAt?.slice(0, 10) ?? '',
    imChannels: [...user.imChannels],
    timezone: user.timezone,
    emailSubscribed: user.emailSubscribed,
  }
}

/** 调用方从可信上下文取得 userId，持久化端口负责提交资料事务。 */
export async function updateProfile<User extends UserProfileRecord>(userId: string, input: UpdateProfileInput, ports: {
  updateProfile(userId: string, input: UpdateProfileInput): Promise<{ timezoneChanged: boolean }>
  bumpContextRevision(userId: string, resource: 'timezone'): Promise<void>
  lookupUser(userId: string): Promise<User | null>
}) {
  const committed = await ports.updateProfile(userId, input)
  if (committed.timezoneChanged) await ports.bumpContextRevision(userId, 'timezone')
  const user = await ports.lookupUser(userId)
  return user ? getProfile(user) : null
}

export class InvalidAvatarError extends Error {
  constructor(readonly code: 'unsupported_media_type' | 'too_large') {
    super(code === 'too_large' ? '头像文件不能超过 5MB' : '仅支持 JPEG/PNG/WebP/GIF 格式')
    this.name = 'InvalidAvatarError'
  }
}

export async function setAvatar<Data extends Uint8Array, User extends UserProfileRecord>(
  userId: string,
  image: { mediaType: string; data: Data },
  upload: (userId: string, mediaType: AvatarMediaType, data: Data) => Promise<User>,
) {
  if (!isAvatarMediaType(image.mediaType)) throw new InvalidAvatarError('unsupported_media_type')
  if (image.data.byteLength > AVATAR_MAX_BYTES) throw new InvalidAvatarError('too_large')
  return getProfile(await upload(userId, image.mediaType, image.data))
}
