import { z } from 'zod'

export const loginBodySchema = z.object({
  username: z.string(),
  password: z.string(),
})

export const clientCreateBodySchema = z.object({
  name: z.string(),
  contact: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  notes: z.string().optional().default(''),
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
