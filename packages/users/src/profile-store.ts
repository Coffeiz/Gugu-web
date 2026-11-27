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

export interface ProfileUpdateStore {
  transaction<T>(work: (transaction: ProfileUpdateTransaction) => Promise<T>): Promise<T>
}
