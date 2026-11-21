import { z } from 'zod'

export const desktopDeepResearchInput = z.object({
  operation_id: z.string().uuid(),
  reconcile_only: z.literal(true).optional(),
  query: z.string().trim().min(1).max(2_000),
  max_results: z.number().int().min(1).max(20).optional(),
  depth: z.enum(['basic', 'advanced']).optional(),
}).strict()

export const desktopDeepResearchResult = z.union([
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({
    kind: z.literal('completed'),
    successful: z.boolean(),
    mutated: z.boolean(),
    value: z.unknown(),
  }).strict(),
])

export const MAX_DESKTOP_SEARCH_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_DESKTOP_SEARCH_IMAGE_BASE64 = Math.ceil(MAX_DESKTOP_SEARCH_IMAGE_BYTES / 3) * 4

const similarImageFields = {
  operation_id: z.string().uuid(),
  reconcile_only: z.literal(true).optional(),
  max_results: z.number().int().min(1).max(20).optional(),
}
const similarImageUrl = z.object({
  ...similarImageFields, image_url: z.string().trim().min(1).max(2_048),
}).strict()
const similarImageReceipt = z.object({
  ...similarImageFields, reconcile_only: z.literal(true), image_digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
export const desktopSimilarImageInput = z.union([
  similarImageUrl, similarImageReceipt,
  z.object({
    ...similarImageFields,
    image_base64: z.string().min(4).max(MAX_DESKTOP_SEARCH_IMAGE_BASE64)
      .refine(value => {
        if (value.length > MAX_DESKTOP_SEARCH_IMAGE_BASE64 || value.length % 4 !== 0) return false
        const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
        return value.length / 4 * 3 - padding <= MAX_DESKTOP_SEARCH_IMAGE_BYTES
          && /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
      }),
  }).strict(),
])
export const desktopSimilarImageHostInput = z.union([
  similarImageUrl, similarImageReceipt,
  z.object({ ...similarImageFields, attach_id: z.string().regex(/^[0-9a-f]{32}$/u) }).strict(),
])

export type DesktopDeepResearchInput = z.infer<typeof desktopDeepResearchInput>
export type DesktopDeepResearchResult = z.infer<typeof desktopDeepResearchResult>
export type DesktopSimilarImageInput = z.infer<typeof desktopSimilarImageInput>
