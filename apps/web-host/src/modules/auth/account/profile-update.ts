import type { ProfileUpdateStore } from '@gugu/users'
import { InvalidProfileTimezoneError, prepareProfilePatch, profileTimezoneChanged, type ProfilePatch, type UpdateProfileInput } from '@gugu/users'
import { PasswordChangeError, preparePasswordChange } from '@gugu/auth'
import { isValidTimezone } from '@gugu/core/date-time'
import { dataContext } from '@gugu/core'

export interface ProfileUpdateInput extends UpdateProfileInput {
  readonly currentPassword?: string
  readonly newPassword?: string
}

export interface ProfileUpdatePorts extends ProfileUpdateStore {
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
    let profilePatch: ProfilePatch
    try {
      profilePatch = prepareProfilePatch(input, isValidTimezone)
    } catch (error) {
      if (error instanceof InvalidProfileTimezoneError) throw new ProfileUpdateError('invalid_timezone')
      throw error
    }

    return ports.transaction(async (transaction) => {
      const current = await transaction.loadForUpdate(ownerId)
      if (!current) throw new ProfileUpdateError('not_found')

      const patch = { ...profilePatch }
      const timezoneChanged = profileTimezoneChanged(profilePatch, current.timezone)

      const { newPassword, currentPassword } = input
      const passwordChanged = Boolean(newPassword)
      if (newPassword) {
        try {
          Object.assign(patch, await preparePasswordChange({ currentPassword, newPassword }, current.hashedPassword, ports))
        } catch (error) {
          if (error instanceof PasswordChangeError) throw new ProfileUpdateError(error.code)
          throw error
        }
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
