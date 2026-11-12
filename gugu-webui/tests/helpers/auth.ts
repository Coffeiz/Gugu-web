import { createHmac } from 'node:crypto'

export function signedUserToken(
  secret: string,
  userId: string,
  securityVersion = 1,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    role: 'user',
    sv: securityVersion,
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url')
  const content = `${header}.${payload}`
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`
}
