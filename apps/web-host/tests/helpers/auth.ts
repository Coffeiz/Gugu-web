import { createUserToken } from '../../src/modules/auth/session/token.js'

export function signedUserToken(
  secret: string,
  userId: string,
  securityVersion = 1,
): string {
  return createUserToken(userId, securityVersion, secret, Date.now(), 60)
}
