export interface AuthAccount {
  readonly id: string
  readonly isActive: boolean
  readonly accountStatus?: string | null
  readonly securityVersion?: number | null
}

export interface VerifiedIdentity {
  readonly userId: string
  readonly securityVersion: number
}

export async function authenticateSession<User extends AuthAccount>(
  identity: VerifiedIdentity, lookup: (userId: string) => Promise<User | null>,
): Promise<User | null> {
  const user = await lookup(identity.userId)
  return user?.isActive && (user.accountStatus ?? 'active') === 'active'
    && (user.securityVersion || 1) === identity.securityVersion ? user : null
}

export async function login<User extends AuthAccount>(input: { username: string; password: string }, ports: {
  authenticateCredentials: (username: string, password: string) => Promise<User | null>
  recordLogin: (userId: string) => Promise<unknown>
  issueCredential: (user: User) => string
}): Promise<{ status: 'invalid_credentials' | 'account_disabled' } | { status: 'authenticated'; user: User; credential: string }> {
  const user = await ports.authenticateCredentials(input.username, input.password)
  if (!user) return { status: 'invalid_credentials' }
  if (!user.isActive) return { status: 'account_disabled' }
  await ports.recordLogin(user.id)
  return { status: 'authenticated', user, credential: ports.issueCredential(user) }
}

export async function logout(userId: string, ports: {
  revokeUserSessions: (userId: string) => Promise<void>
  publishAuthStateChanged: (userId: string) => Promise<unknown>
}): Promise<void> {
  await ports.revokeUserSessions(userId)
  try {
    await ports.publishAuthStateChanged(userId)
  } catch {
    // 会话已经撤销，通知失败不影响登出结果。
  }
}
