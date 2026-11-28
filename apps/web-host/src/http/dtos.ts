import { z } from 'zod'

export { remoteLoginBodySchema as loginBodySchema } from '@gugu/auth/contracts'

export const clientCreateBodySchema = z.object({
  name: z.string(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  notes: z.string().optional().default(''),
}).strict()

export const feedbackCreateBodySchema = z.object({
  category: z.string(),
  content: z.string(),
})

const notificationIdSchema = z.union([
  z.number().int().safe(),
  z.string().regex(/^-?\d+$/).transform(Number).pipe(z.number().int().safe()),
])

export const notificationReadBodySchema = z.object({
  ids: z.array(notificationIdSchema).nullable().optional(),
}).transform(({ ids }) => ids ?? null)

export const trackBodySchema = z.object({
  event: z.string(),
  properties: z.record(z.string(), z.unknown()).nullable().optional(),
}).transform(({ event, properties }) => ({
  event: [...event].slice(0, 64).join(''),
  properties: properties ?? null,
}))
