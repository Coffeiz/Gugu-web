import { z } from 'zod'

export const byokCapability = z.enum(['llm', 'embedding', 'speech_to_text', 'deep_research', 'similar_image_search'])
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const fields = z.object({
  provider: z.string().trim().min(1).max(64),
  api_format: z.string().max(32),
  base_url: z.string().max(500),
  model: z.string().max(200),
})
const secret = z.string().max(20_000)
export const byokSummary = fields.extend({
  id,
  capability: byokCapability,
  enabled: z.boolean(),
  has_value: z.boolean(),
})
export const byokList = z.object({
  enabled: z.literal(true),
  status: z.enum(['ready', 'needs_reconfigure']),
  items: z.array(byokSummary),
})
export const byokTest = z.object({ ok: z.boolean() })
export const byokCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('create'), input: fields.extend({ capability: byokCapability, value: secret }) }),
  z.object({ action: z.literal('update'), id, input: fields.extend({ value: secret }).partial() }),
  z.object({ action: z.literal('test'), id }),
  z.object({ action: z.literal('bind'), id }),
  z.object({ action: z.literal('delete'), id }),
])

export const byokTarget = z.object({ origin: z.string().max(2048), accountId: z.string().uuid() })
export type ByokTarget = z.infer<typeof byokTarget>
export type ByokSummary = z.infer<typeof byokSummary>
export type ByokCommand = z.infer<typeof byokCommand>
export type ByokResult = z.infer<typeof byokList> | ByokSummary | z.infer<typeof byokTest> | null
