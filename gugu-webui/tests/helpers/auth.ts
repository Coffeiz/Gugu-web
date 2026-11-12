import { createUserToken } from '../../src/auth.js'

export function signedUserToken(
  secret: string,
  userId: string,
  securityVersion = 1,
): string {
  return createUserToken(userId, securityVersion, secret, Date.now(), 1 / 60)
}
