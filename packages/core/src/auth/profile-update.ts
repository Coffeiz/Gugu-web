import { isValidTimezone } from '../shared/date-time.js'
import { dataContext } from '../contracts/index.js'

export interface ProfileUpdateInput {
  readonly displayName?: string
  readonly timezone?: string
  readonly emailSubscribed?: boolean
  readonly currentPassword?: string
  readonly newPassword?: string
}

export interface ProfileUpdatePatch {
  readonly displayName?: string | null
  readonly timezone?: string | null
  readonly emailSubscribed?: boolean
  readonly hashedPassword?: string
  readonly incrementSecurityVersion?: true
}

export interface ProfileUpdateTransaction {
  loadForUpdate(ownerId: string): Promise<{
    timezone: string | null
    hashedPassword: string
    securityVersion: number | null
  } | null>
  update(ownerId: string, patch: ProfileUpdatePatch): Promise<{ securityVersion: number | null } | null>
}

export interface ProfileUpdatePorts {
  transaction<T>(work: (transaction: ProfileUpdateTransaction) => Promise<T>): Promise<T>
  verifyPassword(rawPassword: string, hashedPassword: string): Promise<boolean>
  hashPassword(rawPassword: string): Promise<string>
}

export interface ProfileUpdateResult {
  readonly timezoneChanged: boolean
  readonly passwordChanged: boolean
  readonly securityVersion: number | null
}

export type ProfileUpdateErrorCode =
  | 'not_found'
  | 'invalid_timezone'
  | 'current_password_required'
  | 'current_password_invalid'

export class ProfileUpdateError extends Error {
  constructor(readonly code: ProfileUpdateErrorCode) {
    const messages: Record<ProfileUpdateErrorCode, string> = {
      not_found: '用户不存在',
      invalid_timezone: '无效的时区',
      current_password_required: '请输入当前密码',
      current_password_invalid: '当前密码错误',
    }
    super(messages[code])
    this.name = 'ProfileUpdateError'
  }
}

/** Shared profile update rules. Host adapters own the row lock and atomic persistence. */
export function createProfileUpdater(ports: ProfileUpdatePorts) {
  return async (rawOwnerId: string, input: ProfileUpdateInput): Promise<ProfileUpdateResult> => {
    const ownerId = dataContext(rawOwnerId).ownerId
    const timezone = input.timezone?.trim()
    if (timezone && !isValidTimezone(timezone)) throw new ProfileUpdateError('invalid_timezone')

    return ports.transaction(async (transaction) => {
      const current = await transaction.loadForUpdate(ownerId)
      if (!current) throw new ProfileUpdateError('not_found')

      const patch: {
        displayName?: string | null
        timezone?: string | null
        emailSubscribed?: boolean
        hashedPassword?: string
        incrementSecurityVersion?: true
      } = {}
      if (input.displayName !== undefined) patch.displayName = input.displayName.trim() || null
      const timezoneChanged = input.timezone !== undefined
        && (timezone || '') !== (current.timezone || '')
      if (input.timezone !== undefined) patch.timezone = timezone || null
      if (input.emailSubscribed !== undefined) patch.emailSubscribed = input.emailSubscribed

      const passwordChanged = Boolean(input.newPassword)
      if (passwordChanged) {
        if (!input.currentPassword) throw new ProfileUpdateError('current_password_required')
        if (!await ports.verifyPassword(input.currentPassword, current.hashedPassword))
          throw new ProfileUpdateError('current_password_invalid')
        patch.hashedPassword = await ports.hashPassword(input.newPassword!)
        patch.incrementSecurityVersion = true
      }

      let securityVersion = current.securityVersion
      if (Object.keys(patch).length) {
        const updated = await transaction.update(ownerId, patch)
        if (updated === null) throw new ProfileUpdateError('not_found')
        securityVersion = updated.securityVersion
      }
      return {
        timezoneChanged,
        passwordChanged,
        securityVersion: passwordChanged && securityVersion === null
          ? (current.securityVersion ?? 0) + 1
          : securityVersion,
      }
    })
  }
}
