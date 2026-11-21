export type RegistrationValidationError =
  | 'fillAll'
  | 'invalidEmail'
  | 'passwordTooShort'
  | 'passwordMismatch'

export interface RegistrationFields {
  username: string
  email: string
  password: string
  confirmPassword: string
}

export function getRegistrationValidationError(
  fields: RegistrationFields,
): RegistrationValidationError | null {
  if (!fields.username || !fields.email || !fields.password || !fields.confirmPassword) {
    return 'fillAll'
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
    return 'invalidEmail'
  }
  if (fields.password.length < 8) {
    return 'passwordTooShort'
  }
  if (fields.password !== fields.confirmPassword) {
    return 'passwordMismatch'
  }
  return null
}
