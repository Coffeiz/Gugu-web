import { z } from 'zod'

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
}).strict()

export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>

export const remoteLoginBodySchema = z.object({
  username: z.string(),
  password: z.string(),
})

export const remoteUserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string().nullable(),
  email: z.string(),
  isActive: z.boolean(),
  avatarUrl: z.string().nullable(),
  createdAt: z.string(),
  imChannels: z.array(z.string()),
  timezone: z.string().nullable(),
  emailSubscribed: z.boolean(),
})

const bearerSchema = z.string().max(8192).regex(/^[A-Za-z0-9._~+/=-]+$/)

export const remoteLoginResponseSchema = z.object({
  access_token: bearerSchema.nullable(),
  token_type: z.literal('bearer'),
  user: remoteUserSchema,
})

export const remoteLoginInputSchema = remoteLoginBodySchema.extend({
  provider: z.enum(['self-hosted', 'official-saas']),
  server: z.string().trim().min(1).max(2048),
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(4096),
})

export const remoteSessionSchema = z.object({
  provider: z.literal('self-hosted'),
  origin: z.string(),
  accountId: remoteUserSchema.shape.id,
  token: bearerSchema,
})

export type RemoteLoginInput = z.infer<typeof remoteLoginInputSchema>
export type RemoteLoginResponse = Omit<z.infer<typeof remoteLoginResponseSchema>, 'user'> & {
  user: RemoteUser
}
export type RemoteUser = Omit<z.infer<typeof remoteUserSchema>, 'imChannels'> & { imChannels: readonly string[] }
export type RemoteSession = z.infer<typeof remoteSessionSchema>
export type RemoteAccountState =
  | { state: 'signed-out' }
  | { state: 'connected'; origin: string; user: RemoteUser }
  | { state: 'offline' | 'expired'; origin: string }
