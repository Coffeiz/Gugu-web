export const PASSWORD_RESET_TTL_SECONDS = 30 * 60
export const PASSWORD_RESET_COOLDOWN_SECONDS = 60
export const EMAIL_CHANGE_TTL_SECONDS = 30 * 60

export function isRecoveryToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/.test(token)
}

export function validatePasswordReset(token: string, newPassword: string): 'weak_password' | 'missing_token' | null {
  if ([...newPassword].length < 8) return 'weak_password'
  return token ? null : 'missing_token'
}

export function normalizeEmailChangeAddress(value: string): string | null {
  const email = value.trim().toLowerCase()
  if (email.length > 300 || !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(email)) return null
  return email
}

export async function validateEmailChange(
  input: { email: string; currentPassword: string },
  account: { email: string; passwordHash: string | null },
  verifyPassword: (password: string, hash: string) => Promise<boolean>,
): Promise<'current_password_invalid' | 'same_email' | null> {
  if (!account.passwordHash || !await verifyPassword(input.currentPassword, account.passwordHash))
    return 'current_password_invalid'
  return input.email === account.email.trim().toLowerCase() ? 'same_email' : null
}
