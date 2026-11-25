import type { UpdateProfileInput } from './index.js'

export interface ProfilePatch {
  displayName?: string | null
  timezone?: string | null
  emailSubscribed?: boolean
}

export class InvalidProfileTimezoneError extends Error {
  constructor() {
    super('无效的时区')
    this.name = 'InvalidProfileTimezoneError'
  }
}

/** 省略字段保持原值，空白归一为 null。 */
export function prepareProfilePatch(
  input: UpdateProfileInput,
  isValidTimezone: (timezone: string) => boolean,
): ProfilePatch {
  const patch: ProfilePatch = {}
  if (input.displayName !== undefined) patch.displayName = input.displayName?.trim() || null
  if (input.timezone !== undefined) {
    const timezone = input.timezone?.trim() || null
    if (timezone && !isValidTimezone(timezone)) throw new InvalidProfileTimezoneError()
    patch.timezone = timezone
  }
  if (input.emailSubscribed !== undefined) patch.emailSubscribed = input.emailSubscribed
  return patch
}

export function profileTimezoneChanged(patch: ProfilePatch, currentTimezone: string | null): boolean {
  return patch.timezone !== undefined && patch.timezone !== (currentTimezone || null)
}
